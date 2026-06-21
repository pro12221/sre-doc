



2.VictoriaMetrics

VictoriaMetrics 单机版是 VictoriaMetrics 系列中最简单、最推荐的部署模式。官方文档明确表示：在使用集群版之前请三思（think twice before choosing the cluster version），因为单机版在绝大多数场景下已经足够强大。


## 单机
### 部署

```yaml
# vm-grafana.yaml
---
apiVersion: v1
kind: Namespace
metadata:
  name: kube-vm
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: victoria-metrics
  namespace: kube-vm
spec:
  selector:
    matchLabels:
      app: victoria-metrics
  template:
    metadata:
      labels:
        app: victoria-metrics
    spec:
      volumes:
        - name: storage
          persistentVolumeClaim:
            claimName: victoria-metrics-data
      containers:
        - name: vm
          image: uhub.service.ucloud.cn/prometheusv3/victoria-metrics:latest
          imagePullPolicy: IfNotPresent
          args:
            - -storageDataPath=/var/lib/victoria-metrics-data
            - -retentionPeriod=1w
            - -http.pathPrefix=/vm
          ports:
            - containerPort: 8428
              name: http
          volumeMounts:
            - mountPath: /var/lib/victoria-metrics-data
              name: storage
---
apiVersion: v1
kind: Service
metadata:
  name: victoria-metrics
  namespace: kube-vm
spec:
  type: ClusterIP          # 改为 ClusterIP（不写也是默认值）
  ports:
    - name: http
      port: 8428
      targetPort: 8428
      protocol: TCP
  selector:
    app: victoria-metrics
---
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: victoria-metrics
  namespace: kube-vm
spec:
  ingressClassName: nginx
  rules:
    - http:
        paths:
          - path: /vm
            pathType: Prefix
            backend:
              service:
                name: victoria-metrics
                port:
                  number: 8428
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: victoria-metrics-data
  namespace: kube-vm
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 50Gi
  storageClassName: csi-udisk-rssd
```

### prometheus remote write
    global:
      scrape_interval: 15s
      evaluation_interval: 15s
    remote_write:
      - url: http://victoria-metrics.kube-vm.svc.cluster.local:8428/vm/api/v1/write


## 集群 


3.云原生监控工具横向对比


4.VictoriaMetrics 优势是什么 


3.全方位压测证明 VictoriaMetrics的优势 → [详细压测实验设计](prometheus-vs-victoriametrics-benchmark.md)
