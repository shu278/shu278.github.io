---
title: 用 curl 亲手拆开一次 HTTP 请求
date: 2026-11-02 20:50:00
categories:
  - 网络渗透
tags:
  - curl
  - HTTP
  - 主动扫描
  - Kali
---

《主动扫描》课后实践。

## 一、目的

ch4 讲了 nmap、dirb、whatweb 这几个工具，它们底层干的是同一件事——发一个请求，看对方怎么回。curl 就是我亲手去干这件事：请求方法、请求头、请求体，全都由我自己写。

这次我想验证一个具体的问题：能不能用 curl 手工复现一次 whatweb 那种「网站指纹识别」。

## 二、环境

- 攻击机：Kali Linux（VMware 虚拟机，内网 IP `192.168.64.4`）
- 目标：`www.baidu.com` 与 `httpbin.org` 两个公开站点
- curl 版本：8.20.0

本次所有请求都只针对公开网站和公开测试接口，没有对任何未授权的系统发起过测试。

{% asset_img 01-curl-version.png %}
*图 1  curl --version*

## 三、六个练习

### 3.1  抓网页源码：curl 拿到的是什么

```bash
$ curl -s https://www.baidu.com | head -20
```

{% asset_img 02-curl-source.png %}
*图 2  抓取网页源码*

**结论**：curl 拿到的是原始响应体，浏览器是在这堆字符之上再做解析、执行脚本、渲染成页面的。平时我们看网页，看到的是「渲染后的结果」；curl 让我看到了网页的源码。

这也解释了一个现象——同一张网页，右键「查看源代码」和浏览器里看到的差别很大，正是因为前者才是服务器真正发过来的东西。

### 3.2  只看响应头：这一步和 whatweb 是同一件事

```bash
$ curl -I https://www.baidu.com
```

{% asset_img 03-curl-headers.png %}
*图 3  只看响应头*

这段输出里有两处值得说。

第一，`Server` 头只回了 `bfe`，没有版本号。我查到的常见示例是 `bfe/1.0.8.18` 这种带版本的写法，而我这里只有 `bfe`。bfe 是百度自研的接入层，不返回版本号不是它「坏了」，而是有意隐藏——不告诉外面自己跑的是哪一版，别人就没法照着版本号去找对应的已知漏洞。反过来，一个站点 `Server` 头带完整版本号，说明运维没做过基础加固。`Server` 头是服务器自己写的，可以随便改，所以真正做评估时不能只靠这一个头，要看一排特征一起对。

第二，`Content-Length: 0` 并不代表页面是空的。因为 `-I` 发的是 HEAD 请求，只要求响应头、不要正文，长度当然是 0。想看真正的正文大小，就得不带 `-I`。

**结论**：`curl -I` 手工看 `Server` 头，和 whatweb 自动识别网站指纹，是同一个思路，只是一手动、一自动。

### 3.3  看完整握手：一个参数看穿 HTTP 报文结构

```bash
$ curl -v https://www.baidu.com 2>&1 | head -60
```

这里踩了个坑，问题出在 Linux 的一个基础机制：程序其实有两个输出口，而管道 `|` 只接管其中一个（1 号口）。2 号口不经过管道处理，直接送到屏幕上。`curl -v` 就是这样分流的：网页正文走 1 号口，`* Trying...`、`> GET /`、`< HTTP/1.1 200` 这些调试信息全部走 2 号口。这样一来，你想看的（前 60 行里带 `>` 和 `<` 的那部分）被 `head` 截掉了，你不想看的（几百行 `* TLSv1.2`）全都刷在屏幕上。必须写 `2>&1` 把错误流合并进标准输出，`head` 才拦得住。

输出里以 `*` 开头的是 curl 自己的调试信息，`>` 是我发出去的请求头，`<` 是对方回的响应头。

{% asset_img 04-handshake-up.png %}
*图 4  完整握手过程（上）*

{% asset_img 04-handshake-down.jpeg %}
*图 4  完整握手过程（下）*

**第一，先撞 IPv6 再回退 IPv4。** 日志里先出现 `Immediate connect fail for 2408:... : Network is unreachable`，连着两条，然后才 `Trying 157.148.69.151:443`。原因是我的 Kali 没配 IPv6，curl 按顺序先试 IPv6，直接不通，再回退到 IPv4 才连上。

**第二，TLS 1.3 发起，最后协商成 1.2。** 日志里先是 `TLSv1.3 (OUT), TLS handshake, Client hello`，也就是我的客户端支持并优先尝试 TLS 1.3；但往下看会发现 `TLSv1.2 (IN), TLS handshake, Certificate`，最后一行 `SSL connection using TLSv1.2 / ECDHE-RSA-AES128-GCM-SHA256`。这是 TLS 的正常机制：双向协商，取双方都支持的最高版本。顺带还读到了证书信息。

**第三，一条连接的四元组。** 最后有 `Established connection to www.baidu.com (157.148.69.151 port 443) from 192.168.64.4 port 36246`。目标 IP 加 443 端口，源 IP 是我这台 Kali 随机分配的高端口。说到底，扫描器要探的就是这个「IP + 端口」，其余都是在这条连接上做的事。

程序的两个出口：

| 编号 | 名字 | 是什么 | 默认去向 |
|---|---|---|---|
| 0 | stdin 标准输入 | 你喂给程序的东西 | 键盘 |
| 1 | stdout 标准输出 | 程序的正常结果 | 屏幕 |
| 2 | stderr 标准错误 | 报错信息和调试信息 | 屏幕 |

### 3.4  下载文件：-o 和 -O 的区别

```bash
$ curl -o baidu.html https://www.baidu.com
$ curl -O https://nginx.org/download/nginx-1.24.0.tar.gz
$ ls -lh baidu.html nginx-1.24.0.tar.gz
```

{% asset_img 05-download.png %}
*图 5  下载并核对文件*

`-o`（小写）是自己起名字，`-O`（大写）是沿用对方 URL 里的文件名。`ls -lh` 证明文件真的落到了磁盘上。

### 3.5  带参数发 GET

```bash
$ curl "http://httpbin.org/get?user=test&pwd=123"
```

{% asset_img 06-get-params.png %}
*图 6  带参数 GET 请求*

返回的 JSON 里，`args` 字段把两个参数原样回显了，`method` 是 GET，`url` 里也能看到完整参数。

**结论**：GET 的参数是明文拼在 URL 上的，谁都能看见，也能随手改。这正是后面学 SQL 注入的前提——参数完全可控。

### 3.6  POST 与伪装 User-Agent

```bash
$ curl -X POST -d "username=admin&password=123456" http://httpbin.org/post
```

返回的 JSON 里能看到这两行：

```json
"Content-Type": "application/x-www-form-urlencoded",
"form": { "password": "123456", "username": "admin" }
```

`-d` 会自动把请求方法改成 POST，并补上 `Content-Type: application/x-www-form-urlencoded`。返回里的 `form` 字段说明服务端确实收到了这两个字段。

然后是伪装 UA。

```bash
$ curl -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" -v https://www.baidu.com 2>&1 | grep -i "user-agent"
```

{% asset_img 07-user-agent.png %}
*图 7  伪装 User-Agent 的请求头证据*

这条 `> User-Agent` 才是真的证据：请求头确实从默认的 `curl/8.20.0` 变成了浏览器的 UA。

默认的 `curl/8.20.0` 一眼就能看出「这不是浏览器」。有些站点会按 UA 判断来访者，看到 curl 就直接拒绝，或者返回一个假页面糊弄你。扫描器伪装 UA 就是为了不被这么挡在门外——这也是后面学各种「绕过」的起点。UA 是客户端单方面声明的信息，服务端无法验证。

## 四、做完之后的总结

| 工具 | 它其实在干什么 |
|---|---|
| whatweb | 反复发请求，比对 Server、X-Powered-By 等响应头，猜对方是什么 |
| dirb | 拿字典拼 URL，一条条发 GET，看哪个回 200 而不是 404 |
| curl | 上面两个工具的地基——一个请求，由你自己发 |

**问：`curl -I` 和 `curl -v` 都能看到服务端信息，什么时候用哪个？**

**答**：想要一个干净结论时用 `-I`。我这次只想知道「对方是什么服务器、返回什么状态码」。想知道「这一路到底发生了什么」才用 `-v`——它把 DNS 解析、IPv6 撞墙、TLS 握手版本、证书链、甚至源端口都打出来。因此使用：`-I` 用来快速探路，`-v` 用来查问题和写记录。

*附：本文所有命令均在自己可控的环境中对公开站点执行，未针对任何第三方系统做未授权测试。*
