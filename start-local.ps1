# start-local.ps1
# This script starts all backend microservices natively on your laptop (without Docker).
# NOTE: You MUST have PostgreSQL, Redis, and RabbitMQ installed and running on your Windows machine for the services to work.

Write-Host "Starting API Gateway..."
Start-Process "cmd.exe" -ArgumentList "/k cd api-gateway && npm install && npm start"

Write-Host "Starting Auth Service..."
Start-Process "cmd.exe" -ArgumentList "/k cd services\auth-service && npm install && npm run dev"

Write-Host "Starting Product Service..."
Start-Process "cmd.exe" -ArgumentList "/k cd services\product-service && npm install && npm run dev"

Write-Host "Starting Order Service..."
Start-Process "cmd.exe" -ArgumentList "/k cd services\order-service && npm install && npm run dev"

Write-Host "Starting Inventory Service..."
Start-Process "cmd.exe" -ArgumentList "/k cd services\inventory-service && npm install && npm run dev"

Write-Host "Starting Payment Service..."
Start-Process "cmd.exe" -ArgumentList "/k cd services\payment-service && npm install && npm run dev"

Write-Host "Starting AI Recommendation Service..."
Start-Process "cmd.exe" -ArgumentList "/k cd services\ai-recommendation-service && pip install -r requirements.txt && uvicorn main:app --host 0.0.0.0 --port 8000 --reload"

Write-Host "Starting React Native Mobile App..."
Start-Process "cmd.exe" -ArgumentList "/k cd mobile-app && npm install && npx expo start"

Write-Host "All services have been launched in separate windows!"
