.PHONY: secrets up down logs ps api-image fraud-image k8s-build k8s-up k8s-down backup
secrets:
	./scripts/dev-secrets.sh
up:
	docker compose up --build -d
down:
	docker compose down
logs:
	docker compose logs -f --tail=100
ps:
	docker compose ps
api-image:
	docker build -t aegispay-api:local ./backend/go
fraud-image:
	docker build -t aegispay-fraud:local ./backend/python/fraud
k8s-build: api-image fraud-image
k8s-up:
	kubectl apply -k infrastructure/kubernetes/base
k8s-down:
	kubectl delete -k infrastructure/kubernetes/base
backup:
	./scripts/backup-postgres.sh
