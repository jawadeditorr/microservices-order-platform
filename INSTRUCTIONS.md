# INSTRUCTIONS.md — Build & Deploy Guide

> Complete walkthrough: local dev → Dockerized → Kubernetes → CI/CD → Monitoring.
> Follow in order. Each phase is a milestone you can show in an interview.

---

## Prerequisites — Install These First

```bash
# Check you have these installed
node --version        # >= 18
python --version      # >= 3.11
docker --version      # >= 24
docker compose version
kubectl version --client
helm version
minikube version
git --version
```

Install anything missing:
- **Node.js**: https://nodejs.org (use nvm for version management)
- **Docker Desktop**: https://docker.com/products/docker-desktop
- **kubectl**: `brew install kubectl` (Mac) or https://kubernetes.io/docs/tasks/tools
- **Helm**: `brew install helm`
- **Minikube**: `brew install minikube`

---

## Phase 1 — Project Setup

### 1.1 Clone and initialize the repo

```bash
mkdir ecommerce-platform && cd ecommerce-platform
git init
git remote add origin https://github.com/YOUR_USERNAME/ecommerce-platform.git
```

### 1.2 Create the folder structure

```bash
mkdir -p services/{auth-service,product-service,order-service,inventory-service,payment-service,ai-recommendation-service}
mkdir -p kubernetes/helm
mkdir -p monitoring/{prometheus,grafana/dashboards}
mkdir -p .github/workflows
```

### 1.3 Bootstrap each Node.js service

Run this for auth, product, order, inventory, payment services:

```bash
cd services/auth-service
npm init -y
npm install express pg dotenv jsonwebtoken bcryptjs cors helmet express-rate-limit
npm install --save-dev nodemon jest supertest eslint
```

Bootstrap the Python AI service:

```bash
cd services/ai-recommendation-service
python -m venv venv
source venv/bin/activate
pip install fastapi uvicorn psycopg2-binary pgvector anthropic openai python-dotenv
```

### 1.4 Create `.env` files for each service

Each service needs a `.env` (add to `.gitignore`):

```env
# services/auth-service/.env
PORT=3001
DATABASE_URL=postgresql://postgres:password@localhost:5432/auth_db
JWT_SECRET=your-super-secret-key-change-in-production
JWT_REFRESH_SECRET=another-secret-key
NODE_ENV=development
```

```env
# services/product-service/.env
PORT=3002
DATABASE_URL=postgresql://postgres:password@localhost:5432/product_db
REDIS_URL=redis://localhost:6379
AI_SERVICE_URL=http://localhost:8000
```

```env
# services/ai-recommendation-service/.env
PORT=8000
DATABASE_URL=postgresql://postgres:password@localhost:5432/product_db
ANTHROPIC_API_KEY=sk-ant-...
```

---

## Phase 2 — Build Each Service

### 2.1 Auth Service (`services/auth-service/src/index.js`)

Implement these endpoints:
- `POST /auth/register` — create user, hash password, return JWT
- `POST /auth/login` — verify credentials, return access + refresh tokens
- `POST /auth/refresh` — issue new access token from refresh token
- `GET  /auth/me` — return user profile (requires valid JWT)

### 2.2 Product Service (`services/product-service/src/index.js`)

Implement:
- `GET  /products` — list with pagination, filters, full-text search
- `GET  /products/:id` — single product with recommendations (calls AI service)
- `POST /products` — admin: create product
- `PUT  /products/:id` — admin: update product
- `GET  /products/category/:slug` — filter by category

### 2.3 Order Service (`services/order-service/src/index.js`)

Implement:
- `POST /cart/items` — add item to cart
- `GET  /cart` — view cart for current user
- `POST /orders` — create order from cart, publish `order.created` to RabbitMQ
- `GET  /orders` — list user's orders
- `GET  /orders/:id` — order detail with status

### 2.4 Inventory Service (`services/inventory-service/src/index.js`)

Implement:
- `GET  /inventory/:productId` — check stock level
- `PUT  /inventory/:productId` — admin: update stock
- Subscribe to `order.created` RabbitMQ event → decrement stock
- Publish `inventory.low` event when stock < 10

### 2.5 Payment Service (`services/payment-service/src/index.js`)

Implement:
- `POST /payments/initiate` — create a mock payment intent
- `POST /payments/confirm` — simulate payment success, publish `payment.confirmed`
- `POST /payments/webhook` — simulate Stripe webhook for demo
- `GET  /payments/:orderId` — payment status

### 2.6 AI Recommendation Service (`services/ai-recommendation-service/main.py`)

```python
from fastapi import FastAPI
from anthropic import Anthropic

app = FastAPI()
client = Anthropic()

@app.get("/recommendations/{product_id}")
async def get_recommendations(product_id: int):
    # 1. Fetch product details from DB
    # 2. Find similar products via pgvector cosine similarity
    # 3. Ask Claude to explain why these products are related
    # 4. Return products + AI-generated explanation
    pass

@app.post("/embeddings/generate")
async def generate_embedding(product_id: int):
    # Generate and store product embedding in pgvector
    pass
```

---

## Phase 3 — Local Development with Docker Compose

### 3.1 Write Dockerfile for each Node.js service

```dockerfile
# services/auth-service/Dockerfile
FROM node:20-alpine AS base
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

FROM base AS production
COPY src/ ./src/
EXPOSE 3001
CMD ["node", "src/index.js"]
```

```dockerfile
# services/ai-recommendation-service/Dockerfile
FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
```

### 3.2 Write `docker-compose.yml` at project root

```yaml
version: '3.9'

services:
  postgres-auth:
    image: postgres:15-alpine
    environment:
      POSTGRES_DB: auth_db
      POSTGRES_PASSWORD: password
    ports: ["5432:5432"]
    volumes: [auth_data:/var/lib/postgresql/data]

  postgres-product:
    image: ankane/pgvector:latest
    environment:
      POSTGRES_DB: product_db
      POSTGRES_PASSWORD: password
    ports: ["5433:5432"]
    volumes: [product_data:/var/lib/postgresql/data]

  postgres-order:
    image: postgres:15-alpine
    environment:
      POSTGRES_DB: order_db
      POSTGRES_PASSWORD: password
    ports: ["5434:5432"]

  postgres-inventory:
    image: postgres:15-alpine
    environment:
      POSTGRES_DB: inventory_db
      POSTGRES_PASSWORD: password
    ports: ["5435:5432"]

  postgres-payment:
    image: postgres:15-alpine
    environment:
      POSTGRES_DB: payment_db
      POSTGRES_PASSWORD: password
    ports: ["5436:5432"]

  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]

  rabbitmq:
    image: rabbitmq:3.12-management
    ports:
      - "5672:5672"
      - "15672:15672"  # Management UI at localhost:15672

  auth-service:
    build: ./services/auth-service
    ports: ["3001:3001"]
    env_file: ./services/auth-service/.env
    depends_on: [postgres-auth]

  product-service:
    build: ./services/product-service
    ports: ["3002:3002"]
    env_file: ./services/product-service/.env
    depends_on: [postgres-product, redis]

  order-service:
    build: ./services/order-service
    ports: ["3003:3003"]
    env_file: ./services/order-service/.env
    depends_on: [postgres-order, rabbitmq]

  inventory-service:
    build: ./services/inventory-service
    ports: ["3004:3004"]
    env_file: ./services/inventory-service/.env
    depends_on: [postgres-inventory, rabbitmq]

  payment-service:
    build: ./services/payment-service
    ports: ["3005:3005"]
    env_file: ./services/payment-service/.env
    depends_on: [postgres-payment, rabbitmq]

  ai-recommendation-service:
    build: ./services/ai-recommendation-service
    ports: ["8000:8000"]
    env_file: ./services/ai-recommendation-service/.env
    depends_on: [postgres-product]

volumes:
  auth_data:
  product_data:
```

### 3.3 Run locally

```bash
# Start everything
docker compose up --build

# Check all services are healthy
docker compose ps

# View logs for a specific service
docker compose logs -f order-service

# Stop everything
docker compose down
```

---

## Phase 4 — Kubernetes with Helm

### 4.1 Start Minikube

```bash
minikube start --cpus=4 --memory=8192
minikube addons enable ingress
minikube addons enable metrics-server

# Enable Docker to push to Minikube's registry
eval $(minikube docker-env)
```

### 4.2 Create a Helm chart for each service

```bash
helm create kubernetes/helm/auth-service
```

Edit `kubernetes/helm/auth-service/values.yaml`:

```yaml
replicaCount: 2

image:
  repository: your-dockerhub-username/auth-service
  tag: latest
  pullPolicy: IfNotPresent

service:
  type: ClusterIP
  port: 3001

env:
  DATABASE_URL: ""   # Set via K8s Secret
  JWT_SECRET: ""     # Set via K8s Secret

resources:
  requests:
    memory: "128Mi"
    cpu: "100m"
  limits:
    memory: "256Mi"
    cpu: "300m"

autoscaling:
  enabled: true
  minReplicas: 2
  maxReplicas: 10
  targetCPUUtilizationPercentage: 60
```

Edit `kubernetes/helm/auth-service/templates/deployment.yaml` to add HPA:

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: {{ .Release.Name }}-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: {{ .Release.Name }}
  minReplicas: {{ .Values.autoscaling.minReplicas }}
  maxReplicas: {{ .Values.autoscaling.maxReplicas }}
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: {{ .Values.autoscaling.targetCPUUtilizationPercentage }}
```

### 4.3 Create Kubernetes Secrets

```bash
kubectl create namespace ecommerce

kubectl create secret generic auth-secrets \
  --namespace ecommerce \
  --from-literal=DATABASE_URL="postgresql://postgres:password@postgres-auth:5432/auth_db" \
  --from-literal=JWT_SECRET="your-production-secret"
```

### 4.4 Deploy all services

```bash
# Deploy each service
helm install auth-service kubernetes/helm/auth-service \
  --namespace ecommerce \
  --set image.tag=latest

helm install product-service kubernetes/helm/product-service \
  --namespace ecommerce

# ... repeat for all services

# Check everything is running
kubectl get pods -n ecommerce
kubectl get services -n ecommerce
kubectl get hpa -n ecommerce
```

### 4.5 Create the Ingress

```yaml
# kubernetes/ingress.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ecommerce-ingress
  namespace: ecommerce
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /
spec:
  rules:
    - host: ecommerce.local
      http:
        paths:
          - path: /auth
            pathType: Prefix
            backend:
              service:
                name: auth-service
                port:
                  number: 3001
          - path: /products
            pathType: Prefix
            backend:
              service:
                name: product-service
                port:
                  number: 3002
          - path: /orders
            pathType: Prefix
            backend:
              service:
                name: order-service
                port:
                  number: 3003
```

```bash
kubectl apply -f kubernetes/ingress.yaml

# Add to /etc/hosts (Mac/Linux)
echo "$(minikube ip) ecommerce.local" | sudo tee -a /etc/hosts
```

---

## Phase 5 — CI/CD Pipeline (GitHub Actions + ArgoCD)

### 5.1 GitHub Actions — CI pipeline

```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

jobs:
  test-and-build:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        service: [auth-service, product-service, order-service, inventory-service, payment-service]

    steps:
      - uses: actions/checkout@v4

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
          cache-dependency-path: services/${{ matrix.service }}/package-lock.json

      - name: Install dependencies
        run: cd services/${{ matrix.service }} && npm ci

      - name: Run linter
        run: cd services/${{ matrix.service }} && npm run lint

      - name: Run tests
        run: cd services/${{ matrix.service }} && npm test

      - name: Build Docker image
        run: |
          docker build -t ${{ secrets.DOCKERHUB_USERNAME }}/${{ matrix.service }}:${{ github.sha }} \
            ./services/${{ matrix.service }}

      - name: Push to Docker Hub
        if: github.ref == 'refs/heads/main'
        run: |
          echo "${{ secrets.DOCKERHUB_TOKEN }}" | docker login -u "${{ secrets.DOCKERHUB_USERNAME }}" --password-stdin
          docker push ${{ secrets.DOCKERHUB_USERNAME }}/${{ matrix.service }}:${{ github.sha }}
          docker tag ${{ secrets.DOCKERHUB_USERNAME }}/${{ matrix.service }}:${{ github.sha }} \
                     ${{ secrets.DOCKERHUB_USERNAME }}/${{ matrix.service }}:latest
          docker push ${{ secrets.DOCKERHUB_USERNAME }}/${{ matrix.service }}:latest
```

### 5.2 GitHub Actions — CD pipeline (update Helm values)

```yaml
# .github/workflows/cd.yml
name: CD — Update image tags

on:
  workflow_run:
    workflows: ["CI"]
    types: [completed]
    branches: [main]

jobs:
  update-helm-values:
    if: ${{ github.event.workflow_run.conclusion == 'success' }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          token: ${{ secrets.GH_PAT }}

      - name: Update image tags in Helm values
        run: |
          for service in auth-service product-service order-service inventory-service payment-service; do
            sed -i "s/tag: .*/tag: ${{ github.sha }}/" kubernetes/helm/$service/values.yaml
          done

      - name: Commit updated values
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git commit -am "ci: update image tags to ${{ github.sha }}"
          git push
```

### 5.3 Install ArgoCD

```bash
kubectl create namespace argocd
kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml

# Access ArgoCD UI
kubectl port-forward svc/argocd-server -n argocd 8080:443

# Get initial admin password
kubectl -n argocd get secret argocd-initial-admin-secret \
  -o jsonpath="{.data.password}" | base64 -d
```

### 5.4 Create ArgoCD Application

```yaml
# kubernetes/argocd-app.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: ecommerce-platform
  namespace: argocd
spec:
  project: default
  source:
    repoURL: https://github.com/YOUR_USERNAME/ecommerce-platform
    targetRevision: main
    path: kubernetes/helm
  destination:
    server: https://kubernetes.default.svc
    namespace: ecommerce
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
```

```bash
kubectl apply -f kubernetes/argocd-app.yaml
```

Now every push to `main` → GitHub Actions updates Helm values → ArgoCD detects change → auto-deploys.

---

## Phase 6 — Monitoring

### 6.1 Install Prometheus + Grafana via Helm

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update

helm install kube-prometheus-stack prometheus-community/kube-prometheus-stack \
  --namespace monitoring \
  --create-namespace \
  --set grafana.adminPassword=admin123
```

### 6.2 Add Prometheus metrics to each service

```bash
npm install prom-client
```

```javascript
// In each service's index.js
const client = require('prom-client');
const collectDefaultMetrics = client.collectDefaultMetrics;
collectDefaultMetrics();

const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
});

// Add /metrics endpoint
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', client.register.contentType);
  res.end(await client.register.metrics());
});
```

### 6.3 Configure Prometheus scrape config

```yaml
# monitoring/prometheus/prometheus.yml
scrape_configs:
  - job_name: 'auth-service'
    static_configs:
      - targets: ['auth-service.ecommerce.svc.cluster.local:3001']
    metrics_path: /metrics

  - job_name: 'order-service'
    static_configs:
      - targets: ['order-service.ecommerce.svc.cluster.local:3003']
    metrics_path: /metrics
```

### 6.4 Access dashboards

```bash
# Grafana
kubectl port-forward -n monitoring svc/kube-prometheus-stack-grafana 3000:80
# Open http://localhost:3000 (admin / admin123)

# Prometheus
kubectl port-forward -n monitoring svc/kube-prometheus-stack-prometheus 9090:9090
```

Import the "Node.js Application Dashboard" (ID: 11159) in Grafana for instant RED metrics.

---

## Phase 7 — Demo Script (For Interviews)

```bash
# 1. Show all pods running
kubectl get pods -n ecommerce

# 2. Show autoscaling is configured
kubectl get hpa -n ecommerce

# 3. Simulate load to trigger HPA
kubectl run load-test --image=busybox --rm -it -- \
  sh -c "while true; do wget -q -O- http://order-service.ecommerce/orders; done"

# Watch HPA scale up in real time (in another terminal)
kubectl get hpa -n ecommerce --watch

# 4. Show CI/CD — make a small change and push
git commit --allow-empty -m "trigger pipeline"
git push origin main
# Open GitHub Actions to show the pipeline running

# 5. Show ArgoCD sync
kubectl port-forward svc/argocd-server -n argocd 8080:443
# Open https://localhost:8080

# 6. Show Grafana dashboard
kubectl port-forward -n monitoring svc/kube-prometheus-stack-grafana 3000:80
```

---

## Makefile — Convenience Commands

```makefile
.PHONY: up down build deploy logs clean

up:
	docker compose up --build -d

down:
	docker compose down

build:
	docker compose build

deploy:
	helm upgrade --install auth-service kubernetes/helm/auth-service -n ecommerce
	helm upgrade --install product-service kubernetes/helm/product-service -n ecommerce
	helm upgrade --install order-service kubernetes/helm/order-service -n ecommerce
	helm upgrade --install inventory-service kubernetes/helm/inventory-service -n ecommerce
	helm upgrade --install payment-service kubernetes/helm/payment-service -n ecommerce

logs:
	kubectl logs -f -l app=order-service -n ecommerce

status:
	kubectl get pods,svc,hpa,ingress -n ecommerce

clean:
	docker compose down -v
	minikube delete
```

---

## Estimated Build Timeline

| Phase | Time |
|---|---|
| Phase 1 — Setup & scaffolding | 1 day |
| Phase 2 — Build all 6 services | 5–7 days |
| Phase 3 — Docker Compose local | 1 day |
| Phase 4 — Kubernetes + Helm | 2–3 days |
| Phase 5 — CI/CD (GitHub Actions + ArgoCD) | 2 days |
| Phase 6 — Monitoring | 1 day |
| Phase 7 — Polish README + demo | 1 day |
| **Total** | **~2 weeks** |
