.PHONY: up down build deploy logs status clean test-all seed-data

# Local Development
up:
	docker compose up --build -d

down:
	docker compose down

build:
	docker compose build

# Kubernetes Deployment
deploy:
	helm upgrade --install auth-service kubernetes/helm/auth-service -n ecommerce
	helm upgrade --install product-service kubernetes/helm/product-service -n ecommerce
	helm upgrade --install order-service kubernetes/helm/order-service -n ecommerce
	helm upgrade --install inventory-service kubernetes/helm/inventory-service -n ecommerce
	helm upgrade --install payment-service kubernetes/helm/payment-service -n ecommerce
	helm upgrade --install ai-recommendation-service kubernetes/helm/ai-recommendation-service -n ecommerce

logs:
	kubectl logs -f -l app=order-service -n ecommerce

status:
	kubectl get pods,svc,hpa,ingress -n ecommerce

# Clean up
clean:
	docker compose down -v
	minikube delete

# Testing
test-all:
	cd services/auth-service && npm test
	cd services/product-service && npm test
	cd services/order-service && npm test
	cd services/inventory-service && npm test
	cd services/payment-service && npm test

# Database Seeding
seed-data:
	@echo "Running migrations and seeding data..."
	docker compose exec -T postgres-auth psql -U postgres -d auth_db -f /var/lib/postgresql/data/001_init.sql || true
	@echo "Data seeded successfully."
