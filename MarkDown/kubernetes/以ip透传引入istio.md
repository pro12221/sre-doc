## 引入问题
在传统的部署，如直接部署在nginx上，或者部署在docker中，nginx转发到后面的的backend是固定在nginx的配置文件中的，这也很方便排查问题节点在哪儿：直接看access_log中的upstream_addr即可

通过k8s-service的能力，自动做服务发现，每当上/下线一个backend，就会动态发现backend的个数，从此之后，扩缩容就会变得非常简单
但是新的问题来了，问题出现时，比如某个backend出现问题，导致从nginx的日志出现了502，在access_log中显示的upstream_addr并不是后端backend的地址，而是backend-service的地址，无法立刻知道到底是哪个backend 出问题

问题出现了，如何跟踪一条request，能够明确知道它进入了哪一个pod，就是本文需要探索的内容

那就是使用Nginx-ingress 
具体配置
```yaml
root@10-7-180-56:~/gateway# cat ingress.yml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: nginx-test-ingress
  namespace: default
spec:
  rules:
  - host: wilsonchai.com
    http:
      paths:
      - backend:
          service:
            name: backend-service
            port:
              number: 10000
        path: /
        pathType: Prefix

root@10-7-180-56:~/gateway# cat deploy.yml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: backend
  namespace: default
spec:
  replicas: 1
  selector:
    matchLabels:
      app: backend
  template:
    metadata:
      labels:
        app: backend
    spec:
      containers:
      - image: uhub.service.ucloud.cn/prometheusv3/backend-service:v1
        imagePullPolicy: IfNotPresent
        name: backend
        ports:
        - containerPort: 10000
          protocol: TCP
---
apiVersion: v1
kind: Service
metadata:
  name: backend-service
  namespace: default
spec:
  ports:
  - port: 10000
    protocol: TCP
    targetPort: 10000
  selector:
    app: backend
  type: ClusterIP


  10.7.167.255 - - [18/Jun/2026:09:37:13 +0000] "GET / HTTP/1.1" 304 0 "-" "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36" 494 0.006 [default-backend-service-10000] [] 10.7.80.190:10000 0 0.006 304 2759d76abd3a90c6cc6d6a835fcb7ab5

10.7.80.190:10000  这就是pod的真实ip

```