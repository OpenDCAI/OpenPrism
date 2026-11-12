`cent-cert.pem` (to be added at cutover, #166) is the **public** certificate of the Sealed Secrets controller on the cent
cluster. It only encrypts, so it is safe in a public repository. Fetch it after the controller is installed:

    kubectl -n kube-system get secret -l sealedsecrets.bitnami.com/sealed-secrets-key=active \
      -o jsonpath='{.items[0].data.tls\.crt}' | base64 -d > deploy/sealed-secrets/cent-cert.pem

The private key never leaves the cluster except as the one backup described in `deploy/argocd/README.md`.
