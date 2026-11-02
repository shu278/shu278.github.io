---
title: vsftpd 2.3.4「笑脸漏洞」检测 PoC
date: 2026-11-02 23:30:00
tags:
  - vsftpd
  - 漏洞扫描
  - Nmap
  - Metasploit
categories:
  - 网络渗透
---

*CVE-2011-2523 / BID 48539 ｜ Kali + Metasploitable2*

## 一、要验证什么

vsftpd 2.3.4 的 `str.c` 里有一行与程序功能无关的代码，只看用户名里有没有 `:`（0x3a）和 `)`（0x29）；P10 说命中后 6200 端口绑定 `/bin/sh`，且是 root 权限；PoC 证明存在即可，6200 开放就到头。

据此分三步验：21 端口是不是 2.3.4；发完笑脸，6200 是否从不通变通；连上后执行 `id`，是不是 root。三条都成立，才叫漏洞存在。

## 二、环境与靶机定位

| 项目 | 值 |
|---|---|
| Kali（攻击机） | 192.168.64.4 |
| Metasploitable2（靶机） | 192.168.64.3 |
| 网络 | 同一网段，可互 ping |

靶机全程没有登录，只靠端口扫描定位——能登进去看就不叫扫描了。

一条命令扫整个网段：

```bash
nmap -p 21 --open 192.168.64.0/24
```

只有一台开着 21：

```text
Nmap scan report for 192.168.64.3
21/tcp open  ftp
MAC Address: 08:00:27:5E:E9:90 (Oracle VirtualBox virtual NIC)
```

MAC 前缀 `08:00:27` 属于 VirtualBox，可以顺带确认这是一台虚拟靶机。

{% asset_img 01-nmap-discovery.png %}
*图 1　`nmap -p 21 --open` 扫出靶机 192.168.64.3*

## 三、路径一：指定的 NSE 脚本

参考的命令是：

```text
Nmap --script ftp-vsftpd-backdoor 192.168.64.129
```

我把地址换成靶机，并加 `-p 21` 只测 FTP，结果一样但快得多：

```bash
nmap --script ftp-vsftpd-backdoor -p 21 192.168.64.3
```

输出节选：

```text
21/tcp open  ftp
| ftp-vsftpd-backdoor:
|   VULNERABLE:
|   vsftpd version 2.3.4 backdoor command execution
|     State: VULNERABLE (Exploitable)
|     IDs:  BID:48539  CVE:CVE-2011-2523
|   Disclosure date: 2011-07-03
|   Exploit results:
|     Shell command: id
|     Results: uid=0(root) gid=0(root)
```

这段输出有三处值得注意。`State` 后的 `Exploitable` 说明脚本把利用流程走完了，不只是版本号匹配；`Exploit results` 里它自动执行了 `id`，回显 `uid=0(root)`，是既成事实而不是疑似；`BID:48539` 和 `CVE-2011-2523` 是同一个洞的两套编号，报告里都标更规范。所以它比 `nmap -sV` 可靠：版本匹配只说明「可能是」，拿到 `uid=0` 才说明「确实是」。

{% asset_img 02-nse-backdoor.png %}
*图 2　`nmap --script ftp-vsftpd-backdoor` 的完整输出（VULNERABLE + Exploit results）*

## 四、路径二：自己写 Python PoC

### 4.1　先手工走一遍

三步：读 banner、发带笑脸的用户名、连 6200 执行 `id`。手工走不通，代码一定也跑不通，而且到时候分不清是脚本写错还是环境有问题。

发完笑脸后 FTP 的应答靠不住——同一条命令，我见过 `500 OOPS`、`530 Login incorrect`，也有过直接超时。原因是后门在服务器解析用户名那一瞬间就 fork 出去了，与登录成不成功无关。唯一判据是：6200 能不能连上。

### 4.2　第一版：探测把后门用掉了

第一版先探测 6200 是否开放，再决定要不要执行命令，跑出来是这样：

```text
触发前 6200 端口：closed
触发后 6200 端口：open
[!] 连接失败: [Errno 104] Connection reset by peer
```

那句「触发后 open」是我用一条真实 TCP 连接测出来的，问题就在这儿。后门的结构是：

```text
bind(6200) -> listen -> accept（只有一次） -> execl("/bin/sh")
```

探测一握手，就把这唯一一次 `accept` 用掉了，后门把 shell 挂在那条探测连接上；脚本随即 close，shell 收到 EOF 退出。第三步真去连时已经没人在听，内核回了一个 RST——这就是 `Errno 104`。

靶机没问题，是我的检测代码把要检测的东西先消耗掉了。

### 4.3　改法：把探测和利用合成一次连接

改了三处：①删掉 6200 的端口探测，直接连上去执行 `id`，连得上就是开放；②连接失败时重新发一次笑脸再试，最多三次，因为 fork 是异步的，第一次可能还没 bind 好；③判定只看回显里有没有 `uid=0`，不再凭登录应答猜。

最终 56 行，分两张截图。第一张是收包函数和触发函数：

{% asset_img 03-code-talk-trigger.png %}
*图 3　文件头 + talk() + trigger()*

第二张是执行函数和主流程：

{% asset_img 04-code-exploit-main.png %}
*图 4　exploit() + main()*

运行输出：

```text
[步骤1 / P9] 发送笑脸触发后门
  banner : 220 (vsFTPd 2.3.4)
  USER 后: 331 Please specify the password.
  PASS 后: 530 Login incorrect
[步骤2+3 / P10 + P11] 连接 6200 执行 id（点到为止）
  第1次: 连接成功 | 回显: uid=0(root) gid=0(root) groups=0(root)
[结论] 漏洞存在（VULNERABLE）
```

`PASS 后` 那一行是登录失败，但后门照样开了，正好印证 4.1 的结论。

{% asset_img 05-poc-output.png %}
*图 5　脚本完整运行输出（结论 VULNERABLE）*

## 五、踩坑记录

- **坑一**：`recv` 不设超时，读不到数据就永远阻塞，看起来像程序卡死。给 socket 设上 `settimeout`，超时就返回已读到的部分。
- **坑二**：以为端口 open 就等于漏洞可利用，其实那是我自己造出来的一条连接。
- **坑三**：对着不同回显猜结论。`500 OOPS`、超时、`530` 我都分别编过解释，结果它们指向同一件事。

## 附：文中涉及的命令

```bash
# 靶机定位
nmap -p 21 --open 192.168.64.0/24

# 课件指定检测
nmap --script ftp-vsftpd-backdoor -p 21 192.168.64.3

# 自写 PoC
python3 vsftpd234_poc.py 192.168.64.3
```

> 本文实验仅在自己的虚拟靶机上进行，未对任何真实系统发起扫描。
