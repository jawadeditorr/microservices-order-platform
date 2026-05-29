# SKILLS.md — What You Learn & Can Claim in Interviews

> Every skill below is something you will genuinely build in this project —
> not just read about. Use this as your resume bullet point reference.

---

## DevOps Skills (Core — What They're Hiring For)

### Docker & Containerization
- Write multi-stage Dockerfiles that produce production-ready images under 150MB
- Understand layer caching and how to order Dockerfile instructions for fast builds
- Use Docker Compose to orchestrate multi-container local development environments
- Build images with proper `.dockerignore` to exclude dev dependencies
- Tag and push images to Docker Hub / GitHub Container Registry

**Interview answer:** *"I containerized 6 microservices using multi-stage Docker builds, reducing image sizes by ~60% compared to single-stage builds. I used Docker Compose for local dev with all services, databases, and the message broker wired together."*

---

### Kubernetes
- Deploy applications to a K8s cluster using `kubectl` and Helm
- Write and understand Deployments, Services, ConfigMaps, Secrets, Ingress
- Configure Horizontal Pod Autoscaler (HPA) to scale on CPU/memory
- Manage namespaces to isolate environments (dev, staging, prod)
- Debug failing pods: `kubectl describe pod`, `kubectl logs`, `kubectl exec`
- Use `kubectl rollout` for zero-downtime rolling updates and rollbacks
- Understand the difference between ClusterIP, NodePort, and LoadBalancer services

**Interview answer:** *"I deployed all microservices to Kubernetes using Helm charts. I configured HPA on the Order Service to scale from 2 to 10 replicas when CPU exceeds 60% — simulating how you'd handle peak traffic like a flash sale."*

---

### Helm
- Create Helm charts from scratch using `helm create`
- Understand `values.yaml`, `templates/`, `Chart.yaml`
- Use templating (`{{ .Values.image.tag }}`) to make charts environment-agnostic
- Deploy, upgrade, and rollback releases with `helm install`, `helm upgrade`, `helm rollback`
- Override values per environment: `helm install -f values-prod.yaml`

**Interview answer:** *"I wrote Helm charts for all 6 services. Each chart is parameterized so you can deploy to dev, staging, or production just by swapping the values file — no manual manifest editing."*

---

### CI/CD Pipelines (GitHub Actions)
- Write multi-job GitHub Actions workflows triggered on push/PR
- Use matrix strategy to run the same job against multiple services in parallel
- Build and push Docker images to a registry as part of the pipeline
- Store secrets securely in GitHub Secrets (never hardcoded)
- Implement pipeline gates: tests must pass before image is pushed
- Trigger deployment by updating Helm values files and committing back

**Interview answer:** *"My CI pipeline runs on every push: lints the code, runs tests, builds the Docker image, and pushes it to Docker Hub. The CD side updates the Helm chart's image tag and commits it, which ArgoCD then detects and deploys automatically."*

---

### ArgoCD (GitOps)
- Understand the GitOps principle: Git is the single source of truth
- Install ArgoCD on a K8s cluster
- Create Application manifests that track a Git repo
- Use auto-sync to deploy on Git change without manual `kubectl apply`
- Understand the difference between push-based and pull-based CD
- Use the ArgoCD UI to see deployment history, sync status, and rollback

**Interview answer:** *"I implemented GitOps with ArgoCD. My GitHub Actions pipeline commits updated image tags to Git, and ArgoCD continuously reconciles the cluster state with what's in Git. If someone manually changes something in the cluster, ArgoCD detects drift and corrects it."*

---

### Monitoring & Observability
- Install the kube-prometheus-stack (Prometheus + Grafana + Alertmanager) via Helm
- Instrument Node.js services with `prom-client` to expose a `/metrics` endpoint
- Configure Prometheus scrape targets
- Build Grafana dashboards showing the RED method: Rate, Errors, Duration
- Set up Alertmanager rules to fire on error rate > 5%
- Understand the difference between metrics (Prometheus), logs (Loki/ELK), and traces (Jaeger)

**Interview answer:** *"I set up Prometheus and Grafana for all 6 services. Each service exposes custom metrics at /metrics — request count, error rate, and response time histograms. I built Grafana dashboards showing these RED metrics per service so you can instantly see which service is degraded."*

---

## Backend Engineering Skills

### Microservices Architecture
- Implement the database-per-service pattern (no shared databases)
- Use event-driven communication via RabbitMQ for async operations
- Understand when to use synchronous REST vs. asynchronous events
- Handle distributed system challenges: what happens if a service is down?
- Implement health check endpoints (`/health`) consumed by Kubernetes liveness probes
- Apply the 12-factor app principles (config from env vars, stateless processes, etc.)

---

### REST API Design
- Design RESTful APIs with proper HTTP verbs and status codes
- Implement pagination, filtering, and sorting on list endpoints
- Validate request bodies with Joi (Node) or Pydantic (Python)
- Return consistent error response formats
- Document APIs (add Swagger/OpenAPI as a bonus)

---

### PostgreSQL
- Design normalized database schemas with foreign keys and indexes
- Write efficient queries with JOINs, subqueries, and CTEs
- Use database migrations (with `node-pg-migrate` or `Alembic` for Python)
- Set up pgvector extension for AI embedding similarity search
- Understand connection pooling with `pg-pool`

---

### Message Queues (RabbitMQ)
- Understand producer / consumer / exchange / queue concepts
- Publish events from one service and subscribe in another
- Handle message acknowledgment and failed message retries
- Use dead letter queues for failed message handling

---

## AI Integration Skills

- Call the Anthropic Claude API from a Python FastAPI service
- Generate text embeddings and store them in PostgreSQL with pgvector
- Perform cosine similarity search for product recommendations
- Design prompts that return structured JSON from the LLM
- Handle API rate limits and implement exponential backoff retry logic

**Interview answer:** *"The AI recommendation service generates vector embeddings for each product and stores them in pgvector. When a user views a product, I do a cosine similarity search to find the 5 most similar products, then pass them to Claude to generate a natural-language explanation of why they're related."*

---

## Security Skills

- Never hardcode credentials — use environment variables and K8s Secrets
- Implement JWT authentication with access/refresh token rotation
- Use bcrypt for password hashing (understand why MD5/SHA1 are wrong)
- Apply the principle of least privilege in K8s (ServiceAccounts, RBAC)
- Rate limit APIs to prevent abuse

---

## Tools You Can List on Your Resume

```
Docker           Kubernetes       Helm             GitHub Actions
ArgoCD           Prometheus       Grafana          RabbitMQ
Node.js          Python           FastAPI          Express.js
PostgreSQL       Redis            pgvector         JWT
React Native     REST APIs        Microservices    GitOps
```

---

## Talking Points for DevOps Interviews

### "Tell me about a challenging problem you solved"
> *"The Order Service needed to update inventory and trigger payment in a reliable way. I implemented event-driven communication with RabbitMQ so that when an order is created, an event is published and both the Inventory and Payment services react independently. This means a temporary payment service outage doesn't block orders from being placed — they queue up and are processed when the service recovers."*

### "How did you handle secrets management?"
> *"In local dev I use `.env` files that are gitignored. In Kubernetes, all secrets are stored as K8s Secrets, base64-encoded, and injected as environment variables at pod startup. For a production setup I'd migrate to Sealed Secrets or HashiCorp Vault so secrets can safely live in Git in encrypted form."*

### "How does your CI/CD pipeline work end to end?"
> *"Push to main triggers GitHub Actions. It runs tests in parallel across all 6 services using a matrix strategy. If all tests pass, it builds Docker images and pushes them to Docker Hub tagged with the Git commit SHA. Then it updates the image tags in my Helm values files and commits that back to the repo. ArgoCD is watching the repo and immediately starts a rolling deployment in Kubernetes. Total time from push to deployed is about 4 minutes."*

### "How would you scale this for real production traffic?"
> *"The HPA I configured on each service handles short-term spikes. For sustained growth I'd move from Minikube to a managed K8s service like GKE or EKS, use a managed PostgreSQL like Cloud SQL or RDS instead of in-cluster Postgres, add a CDN in front of the product catalog, and shard the database when write throughput becomes the bottleneck."*

---

## What Makes This Portfolio Stand Out

1. It's not a tutorial clone — you built real services that communicate with each other
2. The GitOps workflow (ArgoCD) is what mature teams actually use
3. HPA demo shows you understand ops, not just deployment
4. AI integration shows you're not stuck in 2020
5. You can show the Grafana dashboard live in interviews — most candidates can't
6. The message queue architecture shows you understand distributed systems
