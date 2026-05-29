# Tech Stack — AI-Powered E-Commerce Order Management

> Designed for a DevOps internship portfolio. Every tool here is industry-standard and
> interviewer-recognizable. Choices are intentional — each one has a DevOps story to tell.

---

## Mobile App (Frontend)

| Layer | Technology | Why |
|---|---|---|
| Framework | React Native (Expo) | Cross-platform iOS + Android from one codebase |
| State management | Redux Toolkit + RTK Query | Industry standard, handles async API calls cleanly |
| Auth | JWT tokens stored in SecureStore | Mobile-safe token storage |
| HTTP client | Axios | Interceptors for token refresh |

---

## Microservices (Backend)

All services are written in **Node.js + Express** (fast to build, easy to containerize, JS interviews friendly) or **Python + FastAPI** for the AI service (Python is the lingua franca of AI tooling).

### 1. Auth Service — `Node.js + Express`
- JWT-based authentication and authorization
- bcrypt password hashing
- Role-based access (admin, customer)
- PostgreSQL: `users` table

### 2. Product Catalog Service — `Node.js + Express`
- CRUD for products, categories, images
- Full-text search via PostgreSQL `tsvector`
- Redis cache for hot product pages
- PostgreSQL: `products`, `categories` tables

### 3. Order Service — `Node.js + Express`
- Cart management, order creation, order status tracking
- Publishes `order.created` events to RabbitMQ
- Subscribes to `payment.confirmed` to update order status
- PostgreSQL: `orders`, `order_items`, `carts` tables

### 4. Inventory Service — `Node.js + Express`
- Stock levels, warehouse management
- Subscribes to `order.created` to decrement stock
- Publishes `inventory.low` alerts when stock < threshold
- PostgreSQL: `inventory`, `warehouses` tables

### 5. Payment Service — `Node.js + Express`
- Mock Stripe integration (no real money — safe for portfolio)
- Publishes `payment.confirmed` or `payment.failed` events
- Webhook simulation endpoint for demo purposes
- PostgreSQL: `payments`, `transactions` tables

### 6. AI Recommendation Service — `Python + FastAPI`
- Calls Claude API (or OpenAI) to generate personalized product recommendations
- Generates product embeddings stored in `pgvector` (PostgreSQL extension)
- Cosine similarity search for "customers also bought"
- REST endpoint consumed by Product Catalog Service

---

## Databases

| Service | Database | Notes |
|---|---|---|
| All services | PostgreSQL 15 | One DB instance per service (separate schemas or separate DBs) |
| Product catalog | PostgreSQL + pgvector | Vector embeddings for AI similarity search |
| Product catalog | Redis 7 | Cache hot product pages, session data |
| Message passing | RabbitMQ 3.12 | Event-driven communication between services |

> **DevOps talking point:** "I implemented database-per-service pattern to enforce loose coupling. Each service owns its schema and communicates via events, not direct DB access."

---

## DevOps & Infrastructure

### Containerization
| Tool | Version | Purpose |
|---|---|---|
| Docker | 24+ | Container runtime for all services |
| Docker Compose | v2 | Local development environment |
| Multi-stage Dockerfiles | — | Smaller production images (< 150MB per service) |

### Kubernetes (the core of your portfolio)
| Tool | Version | Purpose |
|---|---|---|
| Kubernetes | 1.28+ | Container orchestration |
| Helm | 3.x | Package manager for K8s manifests |
| Horizontal Pod Autoscaler (HPA) | — | Auto-scale Order Service on traffic spikes |
| Ingress (Nginx or Traefik) | — | Single entry point, TLS termination |
| Secrets (K8s Secrets + Sealed Secrets) | — | Secure credential management |
| ConfigMaps | — | Environment-specific configuration |

> **DevOps talking point:** "I configured HPA on the Order Service to scale from 2 to 10 replicas based on CPU > 60%. This simulates Black Friday traffic handling."

### CI/CD Pipeline
| Tool | Purpose |
|---|---|
| GitHub Actions | CI: lint, test, build Docker image, push to registry |
| Docker Hub / GitHub Container Registry | Container image registry |
| ArgoCD | CD: GitOps-based continuous deployment to K8s |

Pipeline stages:
```
Push to main
  → lint + unit tests
  → build Docker image
  → push image to registry
  → update Helm chart values (image tag)
  → ArgoCD detects Git change → deploys to K8s
```

### Monitoring & Observability
| Tool | Purpose |
|---|---|
| Prometheus | Metrics scraping from all services |
| Grafana | Dashboards: RPS, error rate, latency, pod count |
| Loki | Log aggregation (lightweight ELK alternative) |
| Alertmanager | Alerts to Slack on error rate > 5% |

> **DevOps talking point:** "I set up the RED method dashboards — Rate, Errors, Duration — for each microservice. I can show you the Grafana dashboard."

### Local Development
| Tool | Purpose |
|---|---|
| Docker Compose | Run all 6 services + DBs locally with one command |
| Minikube / kind | Local Kubernetes cluster for testing K8s manifests |
| Makefile | `make up`, `make deploy`, `make logs` shortcuts |
| `.env` files + dotenv | Per-service environment variables |

---

## AI Integration

| Component | Technology |
|---|---|
| LLM API | Anthropic Claude API (claude-sonnet-4-20250514) |
| Embeddings | OpenAI `text-embedding-3-small` or `sentence-transformers` locally |
| Vector store | PostgreSQL + pgvector extension |
| Recommendation logic | Cosine similarity on product embeddings + Claude for explanations |

---

## Security (shows maturity to recruiters)

- JWT with refresh token rotation
- Kubernetes Secrets for API keys (never hardcoded)
- Sealed Secrets for encrypting secrets in Git
- HTTPS via cert-manager + Let's Encrypt (if cloud deployed)
- Rate limiting at the API Gateway layer
- Input validation with Joi (Node) / Pydantic (Python)

---

## Cloud (Optional, for extra points)

If you want to deploy to real cloud, use:

| Option | Cost | Notes |
|---|---|---|
| Minikube (local) | Free | Good enough for portfolio demo |
| Google GKE Autopilot | ~$10/month | Best free tier for K8s |
| AWS EKS | ~$70/month | Expensive but most enterprise-used |
| DigitalOcean Kubernetes | ~$12/month | Cheapest real cloud K8s |

---

## Repository Structure

```
ecommerce-platform/
├── services/
│   ├── auth-service/
│   ├── product-service/
│   ├── order-service/
│   ├── inventory-service/
│   ├── payment-service/
│   └── ai-recommendation-service/
├── kubernetes/
│   ├── helm/
│   │   ├── auth-service/
│   │   ├── product-service/
│   │   └── ...
│   ├── ingress.yaml
│   └── namespace.yaml
├── monitoring/
│   ├── prometheus/
│   │   └── prometheus.yml
│   └── grafana/
│       └── dashboards/
├── .github/
│   └── workflows/
│       ├── ci.yml
│       └── cd.yml
├── docker-compose.yml
├── Makefile
├── INSTRUCTIONS.md
├── TECH_STACK.md
└── SKILLS.md
```
