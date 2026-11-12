{{/* Image reference: <registry>/<name>:<tag> */}}
{{- define "openprism.image" -}}
{{ .root.Values.image.registry }}/{{ .name }}:{{ .root.Values.image.tag | default (printf "v%s" .root.Chart.AppVersion) }}
{{- end }}

{{/* Labels every workload carries. */}}
{{- define "openprism.labels" -}}
app.kubernetes.io/name: {{ .name }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/part-of: openprism
{{- end }}

{{/* Restricted container security context shared by every container. */}}
{{- define "openprism.locked" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop: [ALL]
{{- end }}

{{- define "openprism.imagePullSecrets" -}}
{{- with .Values.image.pullSecrets }}
imagePullSecrets:
  {{- range . }}
  - name: {{ . }}
  {{- end }}
{{- end }}
{{- end }}

{{/*
Environment for every app container. DATABASE_URL and the S3 keys come from the Secret the bootstrap Job creates
(values.credentialsSecret); Kubernetes expands $(DB_PASSWORD) because it is defined earlier in the list.
*/}}
{{- define "openprism.envFrom" -}}
envFrom:
  - configMapRef: {name: openprism-config}
  - secretRef: {name: openprism-core}
{{- end }}

{{- define "openprism.env" -}}
- name: DB_PASSWORD
  valueFrom: {secretKeyRef: {name: {{ .Values.credentialsSecret }}, key: db-password}}
- name: DATABASE_URL
  value: "postgres://{{ .Values.postgres.user }}:$(DB_PASSWORD)@{{ .Values.postgres.host }}:{{ .Values.postgres.port }}/{{ .Values.postgres.database }}"
- name: S3_ACCESS_KEY_ID
  valueFrom: {secretKeyRef: {name: {{ .Values.credentialsSecret }}, key: s3-access-key}}
- name: S3_SECRET_ACCESS_KEY
  valueFrom: {secretKeyRef: {name: {{ .Values.credentialsSecret }}, key: s3-secret-key}}
{{- end }}

{{/* Holds a pod back until the migrate Job has applied this release's migrations. */}}
{{- define "openprism.waitForMigrations" -}}
- name: wait-for-migrations
  image: {{ include "openprism.image" (dict "root" .root "name" .image) }}
  command: ["sh", "-c", "until python manage.py migrate --check >/dev/null 2>&1; do echo 'waiting for database migrations'; sleep 3; done"]
  {{- include "openprism.envFrom" .root | nindent 2 }}
  env:
    {{- include "openprism.env" .root | nindent 4 }}
  securityContext:
    {{- include "openprism.locked" . | nindent 4 }}
  resources: {requests: {cpu: 50m, memory: 128Mi}, limits: {memory: 256Mi}}
{{- end }}

{{/* Pods restart when the settings or the chart-managed secrets change. */}}
{{- define "openprism.configChecksum" -}}
checksum/config: {{ include (print .Template.BasePath "/configmap.yaml") . | sha256sum }}
{{- if .Values.secrets.create }}
checksum/secrets: {{ include (print .Template.BasePath "/secret.yaml") . | sha256sum }}
{{- else }}
{{- /* Secrets come from outside the chart (Sealed Secrets under Argo CD): the seal workflow bumps this to roll the pods. */}}
checksum/secrets: {{ .Values.secrets.revision | toString | quote }}
{{- end }}
{{- end }}
