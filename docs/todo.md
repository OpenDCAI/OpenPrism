# Doing Now

## v0.1.0 - Deploy to the cent Kubernetes cluster

- [ ] #64 Bootstrap the hosted Postgres and MinIO with app-only credentials
- [ ] #65 Helm chart for the cent cluster (replaces `deploy/k8s`)
- [ ] #66 GitHub Actions workflow builds images and deploys to the cluster
- [ ] #67 Caddy2 reference configuration and NodePort documentation

## v0.1.0.1 - v0.1.0 follow-up fixes

- [ ] #69 Image builds exhaust the shared runner's disk

## v0.1.0.2 - v0.1.0.1 follow-up fixes

- [ ] #70 The bootstrap fails silently when its pod cannot start, and cannot be retried alone

## v0.1.0.3 - v0.1.0.2 follow-up fixes

- [ ] #71 The bootstrap's MinIO client image cannot be pulled (replaced by the plain S3 client)

