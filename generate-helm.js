const fs = require('fs');
const path = require('path');

const services = [
  { name: 'auth-service', port: 3001 },
  { name: 'product-service', port: 3002 },
  { name: 'order-service', port: 3003 },
  { name: 'inventory-service', port: 3004 },
  { name: 'payment-service', port: 3005 },
  { name: 'ai-recommendation-service', port: 8000 }
];

const basePath = path.join(__dirname, 'kubernetes', 'helm');

const getChartYaml = (name) => `apiVersion: v2
name: ${name}
description: A Helm chart for ${name}
type: application
version: 0.1.0
appVersion: "1.0.0"
`;

const getValuesYaml = (name, port) => `replicaCount: 2

image:
  repository: your-dockerhub-username/${name}
  tag: latest
  pullPolicy: IfNotPresent

service:
  type: ClusterIP
  port: ${port}

env:
  DATABASE_URL: ""
  JWT_SECRET: ""
  RABBITMQ_URL: ""

resources:
  requests:
    memory: "128Mi"
    cpu: "100m"
  limits:
    memory: "256Mi"
    cpu: "300m"

autoscaling:
  enabled: true
  minReplicas: 2
  maxReplicas: 10
  targetCPUUtilizationPercentage: 60
`;

const getDeploymentYaml = () => `apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ .Release.Name }}
  labels:
    app: {{ .Release.Name }}
spec:
  replicas: {{ .Values.replicaCount }}
  selector:
    matchLabels:
      app: {{ .Release.Name }}
  template:
    metadata:
      labels:
        app: {{ .Release.Name }}
    spec:
      containers:
        - name: {{ .Release.Name }}
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
          imagePullPolicy: {{ .Values.image.pullPolicy }}
          ports:
            - name: http
              containerPort: {{ .Values.service.port }}
              protocol: TCP
          envFrom:
            - secretRef:
                name: {{ .Release.Name }}-secret
          livenessProbe:
            httpGet:
              path: /health
              port: http
            initialDelaySeconds: 15
            periodSeconds: 20
          readinessProbe:
            httpGet:
              path: /health
              port: http
            initialDelaySeconds: 5
            periodSeconds: 10
          resources:
            {{- toYaml .Values.resources | nindent 12 }}
`;

const getServiceYaml = () => `apiVersion: v1
kind: Service
metadata:
  name: {{ .Release.Name }}
  labels:
    app: {{ .Release.Name }}
spec:
  type: {{ .Values.service.type }}
  ports:
    - port: {{ .Values.service.port }}
      targetPort: http
      protocol: TCP
      name: http
  selector:
    app: {{ .Release.Name }}
`;

const getHpaYaml = () => `{{- if .Values.autoscaling.enabled }}
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: {{ .Release.Name }}-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: {{ .Release.Name }}
  minReplicas: {{ .Values.autoscaling.minReplicas }}
  maxReplicas: {{ .Values.autoscaling.maxReplicas }}
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: {{ .Values.autoscaling.targetCPUUtilizationPercentage }}
{{- end }}
`;

const getSecretYaml = () => `apiVersion: v1
kind: Secret
metadata:
  name: {{ .Release.Name }}-secret
type: Opaque
stringData:
  {{- range $key, $val := .Values.env }}
  {{ $key }}: {{ $val | quote }}
  {{- end }}
`;

services.forEach(({ name, port }) => {
  const chartPath = path.join(basePath, name);
  const templatesPath = path.join(chartPath, 'templates');
  
  fs.mkdirSync(templatesPath, { recursive: true });
  
  fs.writeFileSync(path.join(chartPath, 'Chart.yaml'), getChartYaml(name));
  fs.writeFileSync(path.join(chartPath, 'values.yaml'), getValuesYaml(name, port));
  fs.writeFileSync(path.join(templatesPath, 'deployment.yaml'), getDeploymentYaml());
  fs.writeFileSync(path.join(templatesPath, 'service.yaml'), getServiceYaml());
  fs.writeFileSync(path.join(templatesPath, 'hpa.yaml'), getHpaYaml());
  fs.writeFileSync(path.join(templatesPath, 'secret.yaml'), getSecretYaml());
  console.log(`Generated Helm chart for ${name}`);
});
