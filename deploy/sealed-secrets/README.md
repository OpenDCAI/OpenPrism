`cent-cert.pem` is the **public** certificate of the Sealed Secrets controller on the cent cluster (#166; installed
2026-11-12, valid until 2036-11-09, SHA-256 fingerprint `03:A6:92:E0:81:BB:55:BD:C2:47:A9:5C:55:66:2E:CF:DE:14:10:46:EC:AB:51:A2:A0:8F:6F:15:6E:CB:A4:6B`).
It only encrypts, so it is safe in a public repository. To fetch it again (e.g. after the controller was reinstalled):

    kubectl -n kube-system get secret -l sealedsecrets.bitnami.com/sealed-secrets-key=active \
      -o jsonpath='{.items[0].data.tls\.crt}' | base64 -d > deploy/sealed-secrets/cent-cert.pem

The private key never leaves the cluster except as the one backup described in `deploy/argocd/README.md`.
