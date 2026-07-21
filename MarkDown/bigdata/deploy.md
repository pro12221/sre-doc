# Hadoop + Spark + Zookeeper 集群部署记录

> 6 节点生产级 HA 集群部署文档(高可用 HDFS + 高可用 YARN + Spark On YARN)
> 部署完成时间:2026-07-21
> 部署依据:`MarkDown/bigdata/05 hadoop+spark+zookeeper - 副本.pdf`(本地参考文件,不入仓),所有 IP / 主机名 / 路径已按本集群实际环境适配。

---

## 一、集群规划

### 1.1 主机分配

| 主机名     | IP              | 角色 |
|----------|------------------|------|
| spark01  | 192.168.10.100  | Zookeeper · NameNode(active) · ResourceManager(active) |
| spark02  | 192.168.10.101  | Zookeeper · NameNode(standby) |
| spark03  | 192.168.10.102  | Zookeeper · ResourceManager(standby) |
| spark04  | 192.168.10.103  | JournalNode · DataNode · NodeManager · Spark |
| spark05  | 192.168.10.104  | JournalNode · DataNode · NodeManager · Spark |
| spark06  | 192.168.10.105  | JournalNode · DataNode · NodeManager · Spark |

### 1.2 软件版本

| 软件 | 版本 | 安装路径 | 来源 |
|------|------|---------|------|
| OS   | Ubuntu 24.04.3 LTS | — | 已装 |
| JDK  | 1.8.0_202 | `/opt/jdk1.8.0_202` | 已装 |
| Scala | 2.11.12 | `/opt/scala-2.11.12` | 已装 |
| Zookeeper | 3.8.6 | `/root/zookeeper` | 已配置 + 运行中 |
| Hadoop | 2.10.1 | `/root/hadoop-2.10.1` | 下载分发 |
| Spark  | 2.4.8 (bin-hadoop2.7) | `/opt/spark-2.4.8-bin-hadoop2.7` | 下载分发 |

> Spark 选 2.4.8 是因 PDF 推荐 + 与 Scala 2.11 兼容(Hadoop 2.10 的最终稳定组合)。

---

## 二、基础环境

### 2.1 SSH 互通

各节点间 SSH 免密(基于 `id_ed25519_spark_cluster`):

```bash
# spark01 -> spark02..06 已验证 hostname 可取
$ ssh -o BatchMode=yes spark02 hostname
spark02
```

### 2.2 /etc/hosts(6 节点统一)

```
127.0.0.1 localhost
192.168.10.100 spark01
192.168.10.101 spark02
192.168.10.102 spark03
192.168.10.103 spark04
192.168.10.104 spark05
192.168.10.105 spark06
```

### 2.3 /root/.ssh/config(避免 hadoop-daemons.sh 因严格 host key 而失败)

```
Host spark01 spark02 spark03 spark04 spark05 spark06 192.168.10.100 192.168.10.101 192.168.10.102 192.168.10.103 192.168.10.104 192.168.10.105 localhost 127.0.0.1
    User root
    IdentityFile /root/.ssh/id_ed25519_spark_cluster
    IdentitiesOnly yes
    StrictHostKeyChecking no
    UserKnownHostsFile /dev/null
    LogLevel ERROR
```

> 已加 `localhost`/`127.0.0.1`,解决 `hadoop-daemons.sh start journalnode` 时 "localhost: Host key verification failed" 问题。

### 2.4 环境变量(/etc/profile 末尾追加)

```bash
# Java/Hadoop/Scala/Spark env vars
export JAVA_HOME=/opt/jdk1.8.0_202
export JRE_HOME=$JAVA_HOME/jre
export SCALA_HOME=/opt/scala-2.11.12
export HADOOP_HOME=/root/hadoop-2.10.1
export HADOOP_CONF_DIR=$HADOOP_HOME/etc/hadoop
export HADOOP_LOG_DIR=$HADOOP_HOME/logs
export HADOOP_PID_DIR=/root/hadoop-2.10.1/pids
export SPARK_HOME=/opt/spark-2.4.8-bin-hadoop2.7
export PATH=$PATH:$JAVA_HOME/bin:$SCALA_HOME/bin:$HADOOP_HOME/bin:$HADOOP_HOME/sbin:$SPARK_HOME/bin:$SPARK_HOME/sbin
```

spark04-06 才有 `SPARK_HOME`。

---

## 三、Hadoop 部署

### 3.1 包分发

spark01 原本已有 `/root/hadoop-2.10.1`(938M),通过 tar 压缩后 scp 到 spark02-06:

```bash
# spark01
cd /root
tar czf /tmp/hadoop.tgz hadoop-2.10.1    # 392M
for h in spark02 spark03 spark04 spark05 spark06; do
  scp /tmp/hadoop.tgz $h:/tmp/
  ssh $h "cd /root && tar xzf /tmp/hadoop.tgz && rm -f /tmp/hadoop.tgz"
done
rm -f /tmp/hadoop.tgz
```

### 3.2 配置目录创建

6 节点执行:

```bash
mkdir -p /root/hadoop-2.10.1/{tmp/{namenode,datanode},journal,logs,pids}
```

### 3.3 Hadoop 核心配置(6 节点统一)

#### `etc/hadoop/hadoop-env.sh`

```bash
export JAVA_HOME=/opt/jdk1.8.0_202
export HADOOP_HOME=/root/hadoop-2.10.1
export HADOOP_CONF_DIR=${HADOOP_HOME}/etc/hadoop
export HADOOP_LOG_DIR=${HADOOP_HOME}/logs
export HADOOP_PID_DIR=${HADOOP_HOME}/pids
```

#### `etc/hadoop/core-site.xml`

```xml
<configuration>
    <property>
        <name>fs.defaultFS</name>
        <value>hdfs://ns</value>
    </property>
    <property>
        <name>hadoop.tmp.dir</name>
        <value>/root/hadoop-2.10.1/tmp</value>
    </property>
    <property>
        <name>ha.zookeeper.quorum</name>
        <value>spark01:2181,spark02:2181,spark03:2181</value>
    </property>
</configuration>
```

#### `etc/hadoop/hdfs-site.xml`

```xml
<configuration>
    <property><name>dfs.nameservices</name><value>ns</value></property>
    <property><name>dfs.ha.namenodes.ns</name><value>nn1,nn2</value></property>
    <property><name>dfs.namenode.rpc-address.ns.nn1</name><value>spark01:9000</value></property>
    <property><name>dfs.namenode.http-address.ns.nn1</name><value>spark01:50070</value></property>
    <property><name>dfs.namenode.rpc-address.ns.nn2</name><value>spark02:9000</value></property>
    <property><name>dfs.namenode.http-address.ns.nn2</name><value>spark02:50070</value></property>
    <property><name>dfs.namenode.shared.edits.dir</name>
        <value>qjournal://spark04:8485;spark05:8485;spark06:8485/ns</value>
    </property>
    <property><name>dfs.journalnode.edits.dir</name><value>/root/hadoop-2.10.1/journal</value></property>
    <property><name>dfs.ha.automatic-failover.enabled</name><value>true</value></property>
    <property><name>dfs.client.failover.proxy.provider.ns</name>
        <value>org.apache.hadoop.hdfs.server.namenode.ha.ConfiguredFailoverProxyProvider</value>
    </property>
    <property><name>dfs.ha.fencing.methods</name><value>sshfence</value></property>
    <property><name>dfs.ha.fencing.ssh.private-key-files</name>
        <value>/root/.ssh/id_ed25519_spark_cluster</value>
    </property>
    <property><name>dfs.namenode.name.dir</name><value>file:///root/hadoop-2.10.1/tmp/namenode</value></property>
    <property><name>dfs.datanode.data.dir</name><value>file:///root/hadoop-2.10.1/tmp/datanode</value></property>
    <property><name>dfs.replication</name><value>3</value></property>
    <property><name>dfs.permissions</name><value>false</value></property>
</configuration>
```

> `dfs.ha.fencing.ssh.private-key-files` 适配了本集群实际使用的 `id_ed25519_spark_cluster` 密钥,而非 PDF 中的 `id_rsa`。

#### `etc/hadoop/mapred-site.xml`

```xml
<configuration>
    <property>
        <name>mapreduce.framework.name</name>
        <value>yarn</value>
    </property>
</configuration>
```

#### `etc/hadoop/yarn-site.xml`

```xml
<configuration>
    <property><name>yarn.resourcemanager.ha.enabled</name><value>true</value></property>
    <property><name>yarn.resourcemanager.ha.rm-ids</name><value>rm1,rm2</value></property>
    <property><name>yarn.resourcemanager.hostname.rm1</name><value>spark01</value></property>
    <property><name>yarn.resourcemanager.hostname.rm2</name><value>spark03</value></property>
    <property><name>yarn.resourcemanager.ha.automatic-failover.enabled</name><value>true</value></property>
    <property><name>yarn.resourcemanager.ha.automatic-failover.zk-base-path</name><value>/yarn-leader-election</value></property>
    <property><name>yarn.resourcemanager.recovery.enabled</name><value>true</value></property>
    <property><name>yarn.resourcemanager.store.class</name>
        <value>org.apache.hadoop.yarn.server.resourcemanager.recovery.ZKRMStateStore</value>
    </property>
    <property><name>yarn.resourcemanager.zk-address</name>
        <value>spark01:2181,spark02:2181,spark03:2181</value>
    </property>
    <property><name>yarn.resourcemanager.cluster-id</name><value>yarn-ha</value></property>
    <property><name>yarn.nodemanager.aux-services</name><value>mapreduce_shuffle</value></property>
    <property><name>yarn.nodemanager.aux-services.mapreduce.shuffle.class</name>
        <value>org.apache.hadoop.mapred.ShuffleHandler</value>
    </property>
    <property><name>yarn.log-aggregation-enable</name><value>true</value></property>
    <property><name>yarn.log-aggregation.retain-seconds</name><value>106800</value></property>
    <property><name>yarn.nodemanager.resource.cpu-vcores</name><value>4</value></property>
    <property><name>yarn.nodemanager.resource.memory-mb</name><value>4096</value></property>
    <property><name>yarn.scheduler.minimum-allocation-mb</name><value>1024</value></property>
    <property><name>yarn.scheduler.maximum-allocation-mb</name><value>4096</value></property>
    <!-- Spark On YARN 必加:关闭物理/虚拟内存检查,避免 1G 内存被默认 2.1 倍虚拟内存限制溢出而直接被 kill -->
    <property><name>yarn.nodemanager.vmem-check-enabled</name><value>false</value></property>
    <property><name>yarn.nodemanager.pmem-check-enabled</name><value>false</value></property>
</configuration>
```

#### `etc/hadoop/workers`

```
spark04
spark05
spark06
```

> 只有一个文件叫 `workers`(Hadoop 2.x),`slaves` 是 1.x 的别名,配置时统一写 `workers`。

### 3.4 配置文件分发

```bash
# spark01
cd /root/hadoop-2.10.1/etc
tar czf /tmp/hadoop_etc.tgz hadoop    # 20K
for h in spark02 spark03 spark04 spark05 spark06; do
  scp /tmp/hadoop_etc.tgz $h:/tmp/
  ssh $h "cd /root/hadoop-2.10.1/etc && tar xzf /tmp/hadoop_etc.tgz && rm -f /tmp/hadoop_etc.tgz"
done
rm -f /tmp/hadoop_etc.tgz
```

---

## 四、Zookeeper

启动是跳过的(用户预先把 Zookeeper 配好且运行中)。

```bash
$ jps | grep QuorumPeerMain
# spark01 / spark02 / spark03 各一
```

ZK 服务端路径与配置:

- 二进制:`/root/zookeeper/bin/`,日志 `/root/zookeeper/logs/`
- `zoo.cfg` 服务列表:

```
server.1=spark01:2888:3888
server.2=spark02:2888:3888
server.3=spark03:2888:3888
```

---

## 五、Hadoop 集群启动

> 启动顺序非常关键。如果 NN 还没起就跑 `bootstrapStandby`,会一直重试 spark01:9000。

### 5.1 格式化 ZKFC(在 spark01,只执行一次)

```bash
source /etc/profile
hdfs zkfc -formatZK
# log: Successfully created /hadoop-ha/ns in ZK.
```

### 5.2 启动 JournalNode(spark04-06,JN 三台)

最初尝试 `hadoop-daemons.sh start journalnode`(从 spark01)失败,因 `hadoop-daemons.sh` 默认 SSH 走严格 hostkey 到 localhost,而 spark01 的 `~/.ssh/known_hosts` 仅有 IP,首次连接会报 `Host key verification failed`。

最终方案:在 spark04 / spark05 / spark06 上分别直接执行:

```bash
nohup hadoop-daemon.sh start journalnode > /tmp/jn.log 2>&1 &
```

验证:

```bash
$ jps | grep JournalNode
# spark04 / spark05 / spark06 均有
```

### 5.3 格式化 NameNode(spark01)

```bash
source /etc/profile
echo 'Y' | hadoop namenode -format
# log: Storage directory /root/hadoop-2.10.1/tmp/namenode has been successfully formatted.
```

### 5.4 在 spark01 启动 NameNode(active)

```bash
nohup hadoop-daemon.sh start namenode > /tmp/nn.log 2>&1 &
sleep 5
jps | grep NameNode   # NameNode
```

### 5.5 在 spark02 bootstrapStandby + 启动 NN(standby)

```bash
# spark02
hdfs namenode -bootstrapStandby
# log: Storage directory /root/hadoop-2.10.1/tmp/namenode has been successfully formatted.
# log: Downloaded file fsimage.ckpt_0000000000000000000 size 322 bytes.

nohup hadoop-daemon.sh start namenode > /tmp/nn2.log 2>&1 &
jps | grep NameNode
```

### 5.6 启动 DataNode(spark04-06)

```bash
# spark04 / spark05 / spark06 各执行
nohup hadoop-daemon.sh start datanode > /tmp/dn.log 2>&1 &
sleep 3
jps | grep DataNode
```

### 5.7 启动 ZKFC(spark01 / spark02)

```bash
# 两节点各执行
nohup hadoop-daemon.sh start zkfc > /tmp/zkfc.log 2>&1 &
jps | grep DFSZKFailoverController
```

### 5.8 启动 YARN(spark01 + spark03)

```bash
# spark01:start-yarn.sh 启 RM(active)+ 全部 NM
nohup start-yarn.sh > /tmp/yarn.log 2>&1 &
sleep 8

# spark03:启 RM(standby)
nohup yarn-daemon.sh start resourcemanager > /tmp/rm3.log 2>&1 &
```

> `start-yarn.sh` 输出没有显示 NM 启动,排查时发现 spark04-06 上 NodeManager 进程丢失,需逐台启,这是因为 `workers` 文件虽然写了 spark04-06,但 `start-yarn.sh` 在 spark01 上 SSH 触发 NM,过程与 JN 一样走了 hostkey 校验通道。
> 解决方案:**手动补启**:

```bash
# spark04 / spark05 / spark06 各执行
nohup yarn-daemon.sh start nodemanager > /tmp/nm.log 2>&1 &
sleep 5
jps | grep NodeManager
```

---

## 六、Spark 部署

### 6.1 包下载与分发

- 下载地址:`https://repo.huaweicloud.com/apache/spark/spark-2.4.8/spark-2.4.8-bin-hadoop2.7.tgz`(archive.apache.org 在本网络仅 20KB/s,改走华为云镜像达 7MB/s)
- 总大小:225MB,先下载到 Windows 本地,通过 SFTP 推到 spark01,再 tar/scp 到 spark04-06
- 解压目录:`/opt/spark-2.4.8-bin-hadoop2.7`

### 6.2 Spark 配置(spark04 / spark05 / spark06)

#### `conf/spark-env.sh`

```bash
#!/usr/bin/env bash
export JAVA_HOME=/opt/jdk1.8.0_202
export SCALA_HOME=/opt/scala-2.11.12
export HADOOP_HOME=/root/hadoop-2.10.1
export HADOOP_CONF_DIR=/root/hadoop-2.10.1/etc/hadoop
export LANG=en_US.UTF-8
```

#### `conf/spark-defaults.conf`

```
spark.ui.port                           4040
spark.yarn.jars                         hdfs:///spark_jars/*
spark.eventLog.enabled                  true
spark.eventLog.dir                      hdfs:///user/spark/event-log
spark.history.fs.logDirectory           hdfs:///user/spark/event-log
```

#### `conf/slaves`

```
spark04
spark05
spark06
```

> PDF 中 `spark.ui.port 8040` 与 Yarn Scheduler 同端口,会冲突;改成 Spark UI 默认的 `4040`。

### 6.3 上传 Spark jars 到 HDFS(yarn-cluster 复用,避免每次分发)

```bash
# 在 spark04 上执行
mkdir -p /spark_jars /user/spark/event-log
hdfs dfs -mkdir -p /spark_jars /user/spark/event-log
cd /opt/spark-2.4.8-bin-hadoop2.7/jars
hdfs dfs -put ./* /spark_jars/
# 上传了 226 个 jar
```

---

## 七、最终集群状态

### 7.1 `jps` 全景

| 节点 | 进程 |
|------|------|
| spark01 | QuorumPeerMain · NameNode(active) · DFSZKFailoverController · ResourceManager(active) · NodeManager |
| spark02 | QuorumPeerMain · NameNode(standby) · DFSZKFailoverController |
| spark03 | QuorumPeerMain · ResourceManager(standby) |
| spark04 | JournalNode · DataNode · NodeManager |
| spark05 | JournalNode · DataNode · NodeManager |
| spark06 | JournalNode · DataNode · NodeManager |

### 7.2 HA 状态

```bash
$ hdfs haadmin -getServiceState nn1
active
$ hdfs haadmin -getServiceState nn2
standby
$ yarn rmadmin -getServiceState rm1
active
$ yarn rmadmin -getServiceState rm2
standby
```

### 7.3 DataNode 列表

```
$ hdfs dfsadmin -report -live | grep "Name:"
Name: 192.168.10.103:50010 (spark04)   # 96.88 GB
Name: 192.168.10.104:50010 (spark05)
Name: 192.168.10.105:50010 (spark06)
```

### 7.4 HDFS 读写烟测

```bash
$ hdfs dfs -mkdir -p /test
$ echo 'hello hadoop' | hdfs dfs -put - /test/hello.txt
$ hdfs dfs -cat /test/hello.txt
hello hadoop
```

---

## 八、Spark 提交测试

### 8.1 yarn-client(spark-shell)

```bash
$ spark-shell --master yarn --deploy-mode client
Spark context available as 'sc' (master = yarn, app id = application_1784646154599_0001).
```

Client 模式下 Driver 在 spark04 本地,Executor 在 YARN 集群上。

### 8.2 yarn-cluster(spark-submit JavaSparkPi)

```bash
$ spark-submit --master yarn --deploy-mode cluster \
    --class org.apache.spark.examples.JavaSparkPi \
    /opt/spark-2.4.8-bin-hadoop2.7/examples/jars/spark-examples_2.11-2.4.8.jar 80

Application report:
   ApplicationMaster host: spark04
   ApplicationMaster RPC port: 41257
   final status: SUCCEEDED
   tracking URL: http://spark01:8088/proxy/application_1784646154599_0002/
```

成功标志:`final status: SUCCEEDED`。

---

## 九、运维要点

### 9.1 Web UI 入口

- HDFS NameNode 状态(主):
  - `http://spark01:50070`
  - `http://spark02:50070`(当前为 standby)
- YARN 资源管理:
  - `http://spark01:8088`(active)
  - `http://spark03:8088`(RM-Web 也启用;但活跃 RM 是 spark01)
- Spark History:
  - 启动:`$SPARK_HOME/sbin/start-history-server.sh`
  - URL:`http://<history-server-ip>:18080`(本部署未启,需要的话每个 spark04-06 各起一个)

### 9.2 常用运维命令

```bash
# 查看 NN 角色
hdfs haadmin -getServiceState nn1
hdfs haadmin -getServiceState nn2

# 查看 RM 角色
yarn rmadmin -getServiceState rm1
yarn rmadmin -getServiceState rm2

# 重启 ZKFS / NN / DN / JN / RM / NM
hadoop-daemon.sh stop/start zkfc/namenode/datanode/journalnode
yarn-daemon.sh stop/start resourcemanager/nodemanager

# 一键启停 HDFS(start-dfs.sh 需要格式化好 NameNode)
start-dfs.sh     # 拉起 NN(spark01, spark02)+ DN(spark04-06) + JN(spark04-06) + ZKFC(spark01, spark02)
stop-dfs.sh
start-yarn.sh    # 拉起 RM(spark01) + NM(spark04-06)
stop-yarn.sh
yarn-daemon.sh start resourcemanager   # spark03 单独拉 RM
```

### 9.3 故障排查要点

1. **`hadoop-daemons.sh` 跑 SSH 时 `localhost: Host key verification failed`**
   → 在 `/root/.ssh/config` 的 SISYPHUS SPARK CLUSTER CONFIG 块中加入 `localhost` 与 `127.0.0.1`,并设置 `StrictHostKeyChecking no` + `UserKnownHostsFile /dev/null`。

2. **`bootstrapStandby` 失败 `Connection refused` spark01:9000**
   → 顺序错误,必须先 `hadoop-daemon.sh start namenode` 在 spark01 上启好 NN,再在 spark02 上 bootstrapStandby。

3. **YARN 报 `YARN application has exited unexpectedly with state UNDEFINED`**
   → 在 `yarn-site.xml` 里加 `yarn.nodemanager.pmem-check-enabled=false` 和 `yarn.nodemanager.vmem-check-enabled=false`。本部署已配。

4. **`spark.yarn.jars` 警告:Neither spark.yarn.jars nor spark.yarn.archive is set**
   → 把 spark-2.4.8-bin-hadoop2.7/jars/ 全部 PUT 到 HDFS 的 `/spark_jars/`,再在 `spark-defaults.conf` 配 `spark.yarn.jars hdfs:///spark_jars/*`。本部署已配。

5. **`spark.yarn.jars=hdfs://spark01:9000/spark_jars/*` 在 spark01 故障时拿不到 jar**
   → 使用逻辑 URI `hdfs:///spark_jars/*` 走 HA 代理,而不是 `hdfs://spark01:9000/...`。本部署已配。

6. **Spark UI 端口冲突(`8040` 与 YARN scheduler)**
   → `spark.ui.port` 用默认 `4040`,`history server` 用默认 `18080`。

### 9.4 关键配置差异(本集群 vs PDF)

| 项 | PDF 默认 | 本集群适配 | 原因 |
|----|---------|----------|------|
| 集群 IP 段 | 192.168.71.0/24 | 192.168.10.0/24 | 用户实际环境 |
| 安装根目录 | `/home/software/` | `/root/`、`/opt/` | 用户实际路径 |
| SSH 私钥 | `/root/.ssh/id_rsa` | `/root/.ssh/id_ed25519_spark_cluster` | 实际生成的密钥 |
| 资源(vcores/mem) | 物理/虚拟内存自动检查 | 显式 `false` | 兼容 Spark on YARN |
| Spark UI 端口 | 8040 | 4040 | 与 YARN scheduler 避免冲突 |
| `spark.yarn.jars` URI | `hdfs://spark01:9000/...` | `hdfs:///spark_jars/*` | 走 HA(避免单点) |

---

## 十、部署完成清单

- [x] 6 节点 SSH 互通(hostname 可达)
- [x] 6 节点 /etc/hosts 一致
- [x] 6 节点 JDK / Scala / Hadoop 环境变量
- [x] Zookeeper 3 节点 Quorum(已存在)
- [x] HDFS HA 5 节点(2 NN + 3 DN + 3 JN + 2 ZKFC)
- [x] YARN HA 5 节点(2 RM + 4 NM)
- [x] Spark 2.4.8 On YARN(3 spark 节点)
- [x] HDFS 读写验证通过
- [x] spark-shell --master yarn 启动成功
- [x] spark-submit JavaSparkPi --master yarn --deploy-mode cluster **SUCCEEDED**

部署成功。整个集群目前可以承接基于 YARN 的 Spark / MapReduce 任务。
