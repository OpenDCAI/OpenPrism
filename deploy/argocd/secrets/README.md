SealedSecrets for namespace `openprism`, written by the "Seal secrets" workflow (`.github/workflows/seal-secrets.yaml`)
from the GitHub repository secrets. Never edit by hand and never commit an unsealed Secret here. Only the controller in the
cent cluster can decrypt them (sealed with `deploy/sealed-secrets/cent-cert.pem`, scope strict: name and namespace fixed).
