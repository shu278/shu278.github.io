(function(){
var R={
buf:function(l,s,o){return {t:"buf",l:l,s:s,o:o};},
ebp:function(l,s,o){return {t:"ebp",l:l,s:s,o:o};},
ret:function(l,s,o){return {t:"ret",l:l,s:s,o:o};},
seh:function(l,s,o,hot){return {t:"seh",l:l,s:s,o:o,hot:hot};},
teb:function(l,s){return {t:"teb",l:l,s:s};},
nex:function(l,s){return {t:"nex",l:l,s:s};},
sled:function(l,s){return {t:"sled",l:l,s:s};},
sc:function(l,s,hot){return {t:"sc",l:l,s:s,hot:hot};},
paper:function(l,s){return {t:"paper",l:l,s:s};},
evil:function(l,s,hot){return {t:"evil",l:l,s:s,hot:hot};}
};
var S=[
{r:[R.seh("SEH 记录（next + handler）","出错时按它找「谁来处理」，共 8 字节","④"),R.ret("返回地址 RET","函数结束时 ret 取它当下一跳","③"),R.ebp("保存的 EBP","上层栈底，离开时用来还原","②"),R.buf("局部缓冲区 buffer[2048]","程序存放你输入 URI 的地方","①")],
d:"EFS 把 HTTP 请求行里的 URI 用 strcpy 这类函数拷进栈上一个固定长度的数组。栈上这四层从上往下依次挨着：缓冲区、保存的 EBP、返回地址、SEH 记录——顺序就是后面能一路写上去的顺序。",
c:"void handle_uri(char *uri) {\nchar buffer[2048];   // 第 1 层\nstrcpy(buffer, uri); // 没有长度检查\n}\n// 2 EBP → 3 返回地址 → 4 SEH 记录"},
{r:[R.teb("TEB 中的链头","指向栈上最新的那条 SEH 记录"),R.seh("SEH 记录：next","→ 指向外层那条记录，层层嵌套成链"),R.seh("SEH 记录：handler","→ 出错时该由谁处理"),R.ret("返回地址 RET","函数结束时 ret 取它当下一跳"),R.ebp("保存的 EBP","上层栈底，离开时用来还原"),R.buf("局部缓冲区 buffer[2048]","程序存放你输入 URI 的地方")],
d:"编译器为每个 __try 块在栈上登记一条 8 字节的记录：前 4 字节 next 指向外层记录，后 4 字节 handler 是处理函数地址。链头存在线程环境块（TEB）里。请记住这两点——记录本身在栈上，handler 地址也是从栈里读出来的。",
c:"__try { ... }\n__except (filter) { ... }\n\n// 一条记录 = { next(4 字节), handler(4 字节) }\n// 链头 → TEB（线程环境块）\n// 溢出能改的不只是返回地址，还有「该由谁处理异常」"},
{r:[R.evil("SEH 记录：handler","被超长 URI 里多出来的字节盖掉"),R.evil("SEH 记录：next","被盖掉"),R.evil("返回地址 RET","被盖掉"),R.evil("保存的 EBP","被盖掉"),R.buf("局部缓冲区 buffer[2048]","前 2048 字节装正常 URI，余下的继续往上漫")],
d:"正常访问时 URI 只有几十字节，安全。攻击者构造约 4500 字节的超长 URI，写到 2048 就停不下来，多出来的 2400 多字节只能顺着栈往高地址漫，把上面四层依次盖掉。",
c:"strcpy(buffer, uri);   // uri 约 4500 字节\n\n// buffer 只有 2048\n// 多出来的 2400+ 字节只能向高地址蔓延"},
{r:[R.sc("407C　shellcode","D9 CB BE B9 23… 共 61 字节，功能是 WinExec(\"calc.exe\")"),R.sled("4069　NOP 滑板","19 个 90，从 4069 一直铺到 407B"),R.evil("4065　SEH 指针","98 97 01 10 = 0x10019798，pop pop ret 的地址"),R.nex("4061　nSEH","EB 0A（向前跳 10 字节）+ 90 90"),R.buf("填充字节","把上面这些顶到 4061 这个偏移")],
d:"payload 不是乱填：nSEH 放短跳 EB 0A，SEH 指针换成 ImageLoad.dll 里 pop pop ret 的地址（整个 payload 里唯一写死的地址），接着铺 19 个 90 当滑板，最后才是 shellcode。地址从低到高：nSEH → SEH 指针 → 滑板 → shellcode。",
c:"4061  EB 0A        nSEH：向前跳 10 字节\n4063  90 90        nSEH 余下 2 字节\n4065  98 97 01 10  SEH 指针 = 0x10019798\n4069  90 ×19       NOP 滑板（4069~407B）\n407C  D9 CB BE B9  shellcode 首 4 字节"},
{r:[R.sc("407C　shellcode","D9 CB BE B9 23… 共 61 字节"),R.sled("4069　NOP 滑板","19 个 90"),R.evil("4065　SEH 指针","← 系统按链走到这里",1),R.nex("4061　nSEH","EB 0A"),R.buf("填充字节","……")],
d:"EFS 解析畸形 URI 时会先访问一个越界指针，立刻抛出访问违例——函数根本执行不到 ret，覆盖返回地址这条路在此完全无效。于是系统按 SEH 链往下找，走到被改过的那条记录，准备调用它的 handler。",
c:"// 解析畸形 URI → 访问越界指针\n// → 访问违例（ACCESS_VIOLATION）\n// → 函数执行不到 ret，返回地址那条路走不通\n// → 系统开始按 SEH 链找 handler"},
{r:[R.sc("407C　shellcode","等待被跳进来"),R.sled("4069　NOP 滑板","19 个 90"),R.seh("4065　SEH 指针","pop pop ret 地址（正被调用）"),R.nex("4061　nSEH","ret 将落到这里"),R.paper("系统压入：办完回哪去","handler 的返回地址"),R.paper("系统压入：事故报告在哪","异常记录指针"),R.paper("系统压入：建立当前帧的位置","指向栈上那条记录（4061）")],
d:"系统调用 handler 时先压入返回地址和参数——就是那几张挡路的纸。pop 让栈顶下移一格，ret 读出当前栈顶的值当下一跳。pop 两次再 ret，等于把纸一张张扔掉，露出下面那条记录。点「执行 pop pop ret」按钮试试。",
c:"handler:          ; 这段就在 ImageLoad.dll 里\npop               ; 扔掉「办完回哪去」\npop               ; 扔掉「事故报告在哪」\nret               ; 读走「建立当前帧的位置」\n                  ; → 跳向 4061，也就是 nSEH",
act:1},
{r:[R.sc("407C　shellcode","← 正在执行：D9 CB BE B9 23… 共 61 字节",1),R.sled("407B　最后一个 90","滑板尽头，下一步就是 shellcode"),R.nex("406D　落点","4063 + 0A = 406D，第 5 个 NOP，还在滑板里"),R.sled("4069　滑板起点","19 个 90 从这里开始"),R.seh("4065　SEH 指针","pop pop ret 地址（已用过）"),R.nex("4061　nSEH：EB 0A 已执行","跳到 406D")],
d:"ret 落回栈上那条记录（4061），EB 0A 一跳到 406D——注意它落在滑板中间，不是直接落在 shellcode 上。接着一路 90 滑到 407B，407C 起才是 shellcode。计算器弹出，就证明机器码在目标进程里跑起来了。",
c:"4061  EB 0A  →  下一条指令是 4063\n4063 + 0A  =  406D\n406D  90     ← 第 5 个 NOP，仍在滑板里\n...\n407B  90\n407C  D9     ← shellcode 首字节（共 61 字节）"}
];
function esc(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}
function codeHTML(s){return s.split("\n").map(function(l){var t=l.trim();var c=(t.indexOf("//")===0);return c?"<span class=\"cm\">"+esc(l)+"</span>":esc(l);}).join("\n");}
Array.prototype.forEach.call(document.querySelectorAll(".seh-demo"),function(root){
var stack=root.querySelector(".seh-stack"),desc=root.querySelector(".seh-desc"),code=root.querySelector(".seh-code"),foot=root.querySelector(".seh-foot"),num=root.querySelector(".seh-i"),btns=root.querySelectorAll(".seh-nav button"),fire=root.querySelector(".seh-fire");
var cur=-1,torn=false;
function render(){
var s=S[cur],html="",i,row;
for(i=0;i<s.r.length;i++){row=s.r[i];
var cls="seh-row t-"+row.t+(row.o?" has-o":"");
if(row.hot)cls+=" t-hot";
if(torn&&row.t==="paper")cls+=" is-torn";
if(torn&&row.t==="nex")cls+=" t-next";
html+="<div class=\""+cls+"\"><span class=\"l\">"+esc(row.l)+"</span>"+(row.s?"<span class=\"s\">"+esc(row.s)+"</span>":"")+(row.o?"<span class=\"o\">"+row.o+"</span>":"")+"</div>";
}
stack.innerHTML=html;
desc.textContent=s.d;
code.innerHTML=codeHTML(s.c);
num.textContent=String(cur+1);
for(i=0;i<btns.length;i++){btns[i].className=(i===cur?"is-on":"");}
fire.className="seh-fire"+(s.act?" on":"");
fire.textContent=torn?"还原到执行前":"执行 pop pop ret";
foot.textContent=(torn?"已撕掉 3 张：返回地址、异常记录指针、被 ret 读走的地址":"");
}
for(var b=0;b<btns.length;b++){(function(k){btns[k].addEventListener("click",function(){if(k!==cur){cur=k;torn=false;render();}});})(b);}
fire.addEventListener("click",function(){torn=!torn;render();});
cur=0;var hm=location.hash.match(/^#s([1-7])(t?)$/);if(hm){cur=parseInt(hm[1],10)-1;torn=(hm[2]==="t"&&S[cur].act);}render();
});
})();
