---
title: EasyFileSharing-缓冲区溢出漏洞的扫描定位与利用
date: 2026-11-09 20:40:00
categories:
  - 网络渗透
seh_demo: true
tags:
  - Nmap
  - searchsploit
  - Exploit-DB
  - 缓冲区溢出
  - SEH
  - 漏洞扫描
---

一条 4500 字节的超长 URI，把一个正常运行的文件共享服务打崩，还顺手弹出了计算器。这篇文章记录从端口扫描、版本指纹、漏洞检索到 payload 原理的完整链路。

<!-- more -->

## 一、实验目的

1. 掌握使用 Nmap 对目标主机进行端口扫描与服务版本探测的方法，能够正确理解 open / closed / filtered 三种状态的含义。
2. 掌握使用 searchsploit 检索公开漏洞库（Exploit-DB），把“服务版本号”转化为“可利用漏洞代码”的方法。
3. 通过复现 Easy File Sharing Web Server 的远程缓冲区溢出漏洞，理解应用层漏洞的成因、利用链条与危害，并验证“防火墙无法防御应用层攻击”这一结论。
4. 学会用攻击前后的对比数据（端口 open → closed）证明漏洞利用的效果，形成可复现、可验证的实验结论。

## 二、实验环境

| 角色 | 操作系统 | IP 地址 | 主要软件 |
| --- | --- | --- | --- |
| 攻击机 | Kali Linux 2026.2 | 192.168.64.4 | Nmap 7.99、searchsploit、Python 2.7.18 |
| 靶机 | Windows 7（64 位） | 192.168.64.100 | Easy File Sharing Web Server 6.9（监听 8000 端口） |
| 网络 | VirtualBox NAT 网络（KaliLab） | 192.168.64.0/24 | 网关 192.168.64.1 |

### 环境配置要点及原因

| 配置项 | 做法 | 目的 |
| --- | --- | --- |
| 两机同网段 | 均接入 KaliLab 网络，攻击机 192.168.64.4、靶机 192.168.64.100 | 扫描与攻击要求二层可达；NAT 网络与宿主机、校园网隔离，实验流量不外溢 |
| 靶机固定 IP | 手工设为 192.168.64.100 | 后续命令都把该地址写死，动态 IP 会导致命令失效 |
| 关闭靶机防火墙 | 控制面板 → Windows 防火墙 → 家庭/公用两处均选“关闭” | Windows 防火墙默认丢弃入站 ICMP 与 SYN 探测，不关则 Nmap 结果全为 filtered，实验无法进行 |
| 服务端口改为 8000 | EFS 程序界面 Port 框填 8000 → 点 Restart | 80 端口在 Windows 上常被 IIS 等占用；改用 8000 避免冲突，也让扫描目标明确 |

## 三、实验原理

### 3.1　Nmap 版本探测（-sV）的原理

Nmap 判断“端口是否开放”和“端口上跑着什么”是两件不同的事：

1. **端口是否开放**：向目标端口发送 TCP SYN 包。收到 SYN/ACK 表示端口开放（三次握手第一步成功）；收到 RST 表示端口关闭；没有任何回应表示被防火墙丢弃（filtered）。
2. **服务是什么、什么版本**：端口开放后，Nmap 按内置的 nmap-service-probes 探针依次发送数据——先建立空连接等待对方主动报出 Banner，再发送 HTTP GET / HEAD 等针对性请求，把响应内容与指纹正则库匹配，从而识别软件名与版本号。这一过程称为 Banner Grab（旗标抓取）。

之所以必须做这一步：漏洞库是按“软件 + 版本”索引的。不知道对方运行的是 Easy File Sharing Web Server 6.9，就无法检索它对应的漏洞利用代码。版本探测是整个攻击链的入口。

指纹识别的本质可以概括成一句话：问一个只有某个产品才会那样回答的问题。常用手段有三种：

| 手段 | 做法 | 典型特征 |
| --- | --- | --- |
| 看它自报家门 | 读取握手包或响应头中的自我暴露字段 | `Server: Apache/2.4.49`、`X-Powered-By: PHP/7.4.3`、`SSH-2.0-OpenSSH_8.2p1` |
| 故意招惹它 | 请求不存在的路径、发送畸形数据，观察出错方式 | 404 页面长相、报错模板、响应头顺序与措辞 |
| 量化行为特征 | 测量协议层可见的参数 | TCP 窗口大小、TTL、IP ID 递增方式，可反推操作系统 |

由于 Server 等字段可以被管理员改写，成熟的扫描器不会只看一个字段，而是把数十条探针的匹配结果加权计分。本例中 Nmap 从 8000 端口的响应里匹配出“Easy File Sharing Web Server 6.9”，这一行输出是后续全部工作的起点。

#### 指纹库、漏洞库与利用库的分工

{% asset_img fig1-libs.png %}

*图 1　指纹库、漏洞库与利用库的分工*

这些库都是磁盘上的纯文本规则表。Kali 的 /usr/share 目录下，nmap-service-probes 是服务指纹，每条 match 规则对应一段正则和一条“产品 + 版本”结论；files_exploits.csv 是利用库的索引，一行一个漏洞。两者都能用编辑器直接打开阅读。

### 3.2　searchsploit 与 Exploit-DB 的原理

searchsploit 是 Exploit-DB（公开漏洞利用代码库）的本地离线镜像，数据库位于 Kali 的 /usr/share/exploitdb/ 目录。它在本地做关键字与编号检索，不向目标发送任何数据包。检索结果中的路径（如 windows/remote/39009.py）即现成的 PoC 代码位置。

更准确地说，searchsploit 做的是一次本地文本检索，与“扫描”无关：它打开 files_exploits.csv，把关键词与漏洞标题字段做子串匹配，命中的行原样打印。表里的一行长这样：

```
39009, /usr/share/exploitdb/exploits/windows/remote/39009.py,
"Easy File Sharing Web Server 7.2 - Remote Buffer Overflow (SEH)", ...
```

因此检索结果的每一行都不是漏洞描述，而是一张索引卡：编号加存放路径。路径指向的那个 .py 才是完整的 PoC——目标地址、填充长度、跳转地址、shellcode 都已写好，改一个 IP 即可运行。`searchsploit -m 39009` 把该文件从只读的 /usr/share 复制到当前目录，便于修改后使用。

这一步真正的价值是**零暴露**：检索全程不向目标发送任何数据包，靶机日志里不会留下痕迹。整条链路中，只有下面两处动作真正与目标发生通信：

| 动作 | 是否与目标通信 |
| --- | --- |
| `nmap -sV` 探测 | 是，发送探针并等待响应 |
| `searchsploit` 检索 | 否，只读本地文件 |
| 运行 39009.py | 是，发送恶意 HTTP 请求 |

也正因为离线，检索速度极快、不受网络限制，在授权测试中也无需担心因查询行为暴露意图。

### 3.3　栈缓冲区溢出与 SEH 覆盖的原理

**（1）成因。** EFS 在处理 HTTP 请求时，把请求行中的 URI 路径用类似 `strcpy`、`sprintf` 的函数不加长度检查地拷贝到栈上一个固定长度的字符数组里。

**（2）溢出。** 正常访问时 URI 只有几十字节，安全。攻击者构造约 4500 字节的超长 URI，数据就会顺着栈从低地址向高地址漫过去，依次覆盖：局部缓冲区之后的内存 → 保存的 EBP → 函数返回地址 → SEH 异常处理链（nSEH 与 SEH 两个指针）。

**（3）SEH 是什么。** 结构化异常处理（Structured Exception Handling）是 Windows 的异常处理机制，相当于 C 语言的 `__try / __except`。编译器会为每个 `__try` 块在栈上登记一条 8 字节的记录：前 4 字节是 next 指针，后 4 字节是 handler 地址。next 指向外层的那条记录，handler 则是“出错时该由谁处理”的函数地址；层层嵌套便串成一条由内到外的链，称为 SEH 异常处理链，链头保存在线程环境块（TEB）中。

关键有两点：**这条链记录在栈上，而 handler 地址是从栈里读出来的。** 因此溢出不仅能改返回地址，也能改“该由谁处理异常”。

此外，本目标只能走 SEH 这条路径。EFS 在解析畸形 URI 时会先访问一个越界指针，立即抛出访问违例，函数根本执行不到 `ret`，覆盖返回地址的手法在此完全无效。异常处理是进程崩溃前的最后一个出口，也是唯一可劫持的出口。

**（4）劫持执行流。** 32 位 Windows 的结构化异常处理（SEH）会在程序出错时按链表查找异常处理器。攻击者做两件事：

- 把 SEH 指针覆盖为一段 `pop / pop / ret` 指令的地址（该地址取自未启用 SafeSEH 的 ImageLoad.dll）。异常发生时，系统会调用这条 handler，其中最后一条 `ret` 把执行流“弹”回栈上由攻击者控制的数据区；
- 在 nSEH 位置放置短跳指令 `EB 0A`（向前跳 10 字节）：先越过 nSEH 余下的 2 字节与 4 字节 SEH 指针，再跨过紧随其后的填充字节，落到 shellcode 前面的 NOP 滑板上，由滑板把执行流带进 shellcode。

**（5）为什么必须绕 pop pop ret 这一圈。** 既然 shellcode 已经铺在栈上，为什么不直接把 SEH 指针改成 shellcode 的地址？因为栈的地址写不死：程序每次运行时栈的位置都不相同，payload 里写死的栈地址换个环境立即失效。相比之下，DLL 的地址相对稳定，于是借用软件自身 ImageLoad.dll 中一段现成的 pop-pop-ret 指令作中转站——这是整个 payload 里唯一需要预先确定的地址。

至于 `ret` 之后落到哪里，由系统自己给出：异常处理框架会把“建立当前帧的位置”作为参数传给 handler，它天然指向栈上那条 SEH 记录，不需要攻击者知道具体数值。落到栈上之后，再用 `EB 0A` 这类相对跳转跨过 nSEH 残余、SEH 指针与中间的填充字节，落到 shellcode 前的 NOP 滑板，由滑板带进 shellcode——相对跳转只关心“往前几个字节”，不关心“我此刻在哪里”，正好绕开地址不确定的问题。

> NOP 滑板：连续的 `90` 字节。`90` 在汇编里是 `NOP`，不做任何事，直接执行下一条指令。执行流只要落到滑板上的任意一点，就会一路“滑”到滑板尽头的 shellcode。

**（6）执行 shellcode。** shellcode 是精心构造的机器码，本次功能为调用 `WinExec("calc.exe")`。计算器弹出即证明攻击者已在目标机器上执行任意代码；若换成反弹 shell 类型的 payload，得到的就是一台被完全控制的主机。

**（7）服务崩溃。** 溢出破坏了栈结构，进程无法继续正常服务，EFS 的监听端口随之消失，网站无法访问。

#### 栈布局与覆盖顺序示意

{% asset_img fig2-stack.png %}

*图 2　栈帧布局与溢出覆盖顺序*

#### pop pop ret 的执行过程

系统调用 handler 时，会先在栈顶压入返回地址与异常记录等参数，也就是所谓“两张挡路的纸”。`pop` 的作用是把栈顶指针下移一格，`ret` 则是读出当前栈顶的值作为下一跳地址。因此 `pop` 两次再 `ret`，效果就是：扔掉系统压入的两条参数，让栈顶露出攻击者铺好的那个地址，从而把执行流带回栈上。下图对比了执行前后的栈状态。

<div class="seh-demo">
<div class="seh-top"><span class="seh-t">pop pop ret 执行过程：点着走一遍</span><span class="seh-n">第 <b class="seh-i">1</b> / 7 步</span></div>
<div class="seh-nav"><button type="button">1 正常时的栈</button><button type="button">2 链头在 TEB</button><button type="button">3 4500 字节漫过去</button><button type="button">4 payload 布局</button><button type="button">5 触发异常</button><button type="button">6 pop pop ret</button><button type="button">7 落进 shellcode</button></div>
<div class="seh-grid">
<div class="seh-left"><div class="seh-cap">栈（越往上地址越高）</div><div class="seh-hi">高地址</div><div class="seh-stack"></div><div class="seh-lo">低地址 · 栈顶方向</div><div class="seh-foot"></div></div>
<div class="seh-right"><p class="seh-desc"></p><div class="seh-actwrap"><button type="button" class="seh-fire">执行 pop pop ret</button></div><div class="seh-cap">这一步在代码里长这样</div><pre class="seh-code"></pre></div>
</div>
</div>

*图 3　pop pop ret 执行过程（可逐步点击，左栏是栈、右栏是这一步对应的代码）*

{% asset_img fig4-payload-bytes.png %}

*图 4　payload 逐字节布局：短跳落点与 NOP 滑板*

为什么防火墙拦不住。整个攻击是一个语法完全合法的 HTTP HEAD 请求，目标端口 8000 是业务端口、必须对外开放，内容看起来与普通网页访问没有区别。防火墙工作在网络层与传输层（看 IP、端口、连接状态），看不到“URI 长度异常”这种应用层语义。防御此类攻击只能依靠应用层手段：打补丁、升级版本、WAF/IPS 检测异常长的请求、编译期保护（GS / SafeSEH / DEP）。

## 四、实验步骤与结果

### 步骤 1　信息收集：扫描目标端口与服务版本

在 Kali 终端执行：

```bash
nmap -sV -p 8000 192.168.64.100
```

实测输出：

```
PORT     STATE SERVICE VERSION
8000/tcp open  http    Easy File Sharing Web Server httpd 6.9
MAC Address: 08:00:27:C3:C5:17 (Oracle VirtualBox virtual NIC)
Service Info: OS: Windows; CPE: cpe:/o:microsoft:windows
```

{% asset_img fig5-nmap.png %}

*图 5　Nmap 探测出目标运行 Easy File Sharing Web Server 6.9*

`open` 是这里唯一有意义的判断依据：端口开放、服务指纹识别为 Easy File Sharing Web Server 6.9、操作系统为 Windows。至此取得了攻击的“钥匙”——软件名与版本号（6.9），下一步就是拿它去换代码。

### 步骤 2　漏洞检索：把版本号换成漏洞利用代码

```bash
searchsploit Easy File Sharing
```

结果中与本次目标相关的条目（节选）：

```
Easy File Sharing Web Server 6.9 - USERID Remote Buffer Overflow      | windows/remote/37951.py
Easy File Sharing Web Server 7.2 - HEAD Request Buffer Overflow (SEH) | windows/remote/39009.py
Easy File Sharing Web Server 7.2 - POST Request Buffer Overflow (SEH) | windows/remote/39008.py
Easy File Sharing Web Server 7.2 - Remote Buffer Overflow             | windows/remote/38526.py
```

{% asset_img fig6-searchsploit.png %}

*图 6　searchsploit 检索到的 EFS 相关漏洞利用代码*

确认该软件存在多个远程缓冲区溢出漏洞，其中 39009.py（HEAD 请求溢出、SEH 型）对 6.9 版同样有效。

### 步骤 3　实施攻击：运行溢出脚本

```bash
cd ~
cp /usr/share/exploitdb/exploits/windows/remote/39009.py .
python2 39009.py 192.168.64.100 8000
```

执行输出：

```
Connecting to: 192.168.64.100:8000
Done...
```

{% asset_img fig7-exploit-run.png %}

*图 7　攻击脚本执行完成，payload 已发往目标*

脚本向目标发送一个 URI 长度约 4500 字节的 HTTP HEAD 请求，其中按固定偏移布置了 NOP 滑板、shellcode、短跳（nSEH）与 pop-pop-ret 地址（SEH）——也就是 3.3 节讲的那套布局。

### 步骤 4　效果验证：靶机侧取证

攻击后立即观察靶机，出现两个现象：

1. 弹出“计算器”窗口——证明 shellcode 被执行，攻击者获得了任意代码执行能力（本次 payload 的功能仅为打开计算器，若换成反弹木马即为完全控制）；
2. EFS 程序异常退出、托盘图标消失——说明溢出破坏了进程的栈结构，服务进程崩溃。

{% asset_img fig8-calc.png %}

*图 8　靶机弹出计算器，证明代码执行成功*

### 步骤 5　结果确认：服务可用性与端口状态对比

攻击前：靶机浏览器访问 `http://127.0.0.1:8000` 正常显示 EFS 的共享页面。

攻击后：同一地址显示“Internet Explorer 无法显示该网页”。

再回到 Kali 复扫：

```bash
nmap -sV -p 8000 192.168.64.100
```

```
PORT     STATE  SERVICE
8000/tcp closed http-alt
```

结果分析（关键）：**open → closed 是本次实验最硬的证据。** 输出中同时存在 Host is up、延迟 0.00085s，说明网络通畅、主机存活，被精确打掉的是服务进程本身，而非主机或防火墙。

| 状态 | 含义 | 本次对应情况 |
| --- | --- | --- |
| open | 端口开放，有进程在监听 | 攻击前，服务正常运行 |
| closed | 主机可达，但该端口无进程监听 | 攻击后，服务进程已被打崩 |
| filtered | 探测包被防火墙等设备丢弃 | 本次未出现，可排除防火墙干扰 |

{% asset_img fig9-down.png %}

*图 9　靶机网站无法访问，服务已崩溃*

## 五、实验结果汇总

| 检查点 | 攻击前 | 攻击后 | 结论 |
| --- | --- | --- | --- |
| 8000 端口状态 | open（Easy File Sharing Web Server httpd 6.9） | closed | 服务进程崩溃 |
| EFS 网页 | 正常显示登录/共享页面 | 无法显示该网页 | 业务中断 |
| 靶机进程 | 正常运行 | 弹出计算器、服务退出 | 任意代码执行 + 拒绝服务 |
| 靶机主机状态 | 存活 | 仍存活（ping 通） | 攻击针对服务而非主机 |

结论：Easy File Sharing Web Server 6.9 存在远程栈缓冲区溢出漏洞（SEH 型）。攻击者无需任何认证，仅需一个 HTTP 请求即可在目标机器上执行任意代码并造成服务瘫痪。该漏洞属于应用层漏洞，防火墙、端口过滤等网络层防护手段对其无效。

## 六、安全加固建议

1. **升级或停用该软件。** 该版本已停止维护且存在多个溢出漏洞，应升级到最新版，或改用其他文件共享方案（如 Nextcloud、加固配置的 SMB 服务）。
2. **最小暴露面。** 不要把文件共享服务直接暴露在公网；确需外网访问应置于 VPN 之后，并限制来源 IP。
3. **应用层防护。** 部署 WAF/IPS，对超长 URI、异常 HEAD/POST 请求进行拦截与告警。
4. **服务降权运行。** 以低权限账户运行 Web 服务，避免攻击成功后直接获得管理员权限。
5. **系统与编译保护。** 启用 DEP、ASLR；软件编译时开启 /GS 与 SafeSEH，使“覆盖返回地址/SEH”的经典手法难以奏效。
6. **持续巡检。** 定期使用 Nmap 等工具自查资产暴露情况，把“公网上不该出现的服务”尽早下线。

## 附：实验命令清单

```bash
# 1. 端口与服务版本扫描
nmap -sV -p 8000 192.168.64.100

# 2. 检索公开漏洞利用代码
searchsploit Easy File Sharing

# 3. 复制并执行漏洞利用脚本（参数：目标 IP、目标端口）
cp /usr/share/exploitdb/exploits/windows/remote/39009.py ~ && cd ~
python2 39009.py 192.168.64.100 8000

# 4. 验证服务是否已崩溃
nmap -sV -p 8000 192.168.64.100
```

恢复实验环境：在靶机上重新打开 Easy File Sharing Web Server，点击 Start 或 Restart 重新启动服务，即可再次进行实验（该溢出攻击是一次性的，服务崩溃后需重启进程）。
