#Requires AutoHotkey v2.0
#SingleInstance Force
; ============================================================
; 旺店通「销售日报统计」自动导出
;   AutoHotkey64.exe wdt-export.ahk 2026-11-13 2026-11-19
;   AutoHotkey64.exe wdt-export.ahk --verify        ; 只校验坐标，不点鼠标
;
; 坐标双证：相对客户区（跟窗口走）+ 屏幕绝对（钉死位置）
;   两者算出的点一致      → 用相对（等价，安全）
;   有偏差但相对仍在窗口内 → 说明窗口挪过了，用相对
;   相对越界              → 说明窗口被缩放/换屏，退回绝对
; ============================================================
SetWorkingDir A_ScriptDir
CoordMode "Mouse", "Screen"
global CoordFile := A_ScriptDir "\wdt-coords.ini"
global LogFile := A_ScriptDir "\wdt-export.log"
global CheckFile := A_ScriptDir "\wdt-coords-check.txt"
global WIN := "ahk_exe 旺店通ERP旗舰版.exe"
global OUT_DIR := "D:\振颜丽舍\wdt\每日导出"
global gMain := 0
global gOrig := 0
global gMoved := false

KEYS := ["menu", "sale", "daily", "from", "fromok", "to", "took",
         "search", "header", "export", "tpl", "ok"]

VERIFY := (A_Args.Length >= 1 && A_Args[1] = "--verify")
FROM := (!VERIFY && A_Args.Length >= 1) ? A_Args[1] : FormatTime(DateAdd(A_Now, -6, "Days"), "yyyy-MM-dd")
TO := (!VERIFY && A_Args.Length >= 2) ? A_Args[2] : FormatTime(A_Now, "yyyy-MM-dd")

Log(msg) {
  FileAppend FormatTime(A_Now, "yyyy-MM-dd HH:mm:ss") "  " msg "`n", LogFile, "UTF-8"
}

Rel(key, dflt := "") => IniRead(CoordFile, "coords", key, dflt)
AbsC(key, dflt := "") => IniRead(CoordFile, "abs", key, dflt)
Has(key) => (Rel(key "X") != "" || AbsC(key "X") != "")

if !FileExist(CoordFile) {
  FileAppend "缺少 wdt-coords.ini，请先运行校准。`n", CheckFile, "UTF-8"
  Done(1)
}

; ---- 找主窗口（面积最大，排除通知条 / 浮窗） ----
main := 0, area := 0
for hwnd in WinGetList(WIN) {
  try {
    WinGetPos &x, &y, &w, &h, "ahk_id " hwnd
    if (w * h > area) {
      area := w * h
      main := hwnd
    }
  }
}
if !main && !VERIFY {
  Log("旺店通未运行，尝试启动")
  try {
    Run "C:/Program Files (x86)/旺店通ERP旗舰版/旺店通ERP旗舰版.exe"
    ; 冷启动 + 自动登录可能要半分钟，轮询等主窗口，别死等固定时间
    Loop 30 {
      Sleep 2000
      area := 0
      for hwnd in WinGetList(WIN) {
        try {
          WinGetPos &x, &y, &w, &h, "ahk_id " hwnd
          if (w * h > area) {
            area := w * h
            main := hwnd
          }
        }
      }
      if main
        break
    }
    if !main {
      ; 可能有登录窗口挡着，先把原因记下来，方便第二天看
      for hwnd in WinGetList() {
        t := ""
        try t := WinGetTitle("ahk_id " hwnd)
        if RegExMatch(t, "登录|登陆|扫码")
          Log("疑似登录窗口：" t "（需人工登录一次）")
      }
    }
  }
}
if !main {
  if VERIFY {
    ; 不弹框：调用方是无人值守脚本，弹框会一直挂着
    FileAppend "旺店通未运行（只找到后台任务进程），无法校验窗口坐标。`n", CheckFile, "UTF-8"
    Done(2)
  }
  Log("启动失败：找不到窗口")
  Done(1)
}
gMain := main

/* ---------------- 双证求解 ---------------- */
; 返回 {ok, x, y, src, d, relX, relY, absX, absY, inside}
Resolve(key) {
  global CoordFile, gMain
  relX := IniRead(CoordFile, "coords", key "X", "")
  relY := IniRead(CoordFile, "coords", key "Y", "")
  absX := IniRead(CoordFile, "abs", key "X", "")
  absY := IniRead(CoordFile, "abs", key "Y", "")
  if (relX = "" && absX = "")
    return { ok: false, x: 0, y: 0, src: "缺失", d: 0 }

  if (relX = "")                     ; 只有绝对
    return { ok: true, x: absX, y: absY, src: "仅绝对", d: 0, inside: false }

  ; 用「此刻」的客户区原点把相对坐标换算成屏幕点
  WinGetClientPos &cx, &cy, &cw, &ch, "ahk_id " gMain
  px := cx + relX
  py := cy + relY
  inside := (relX >= -6 && relX <= cw + 6 && relY >= -6 && relY <= ch + 6)

  if (absX = "")                     ; 只有相对
    return { ok: true, x: px, y: py, src: "仅相对", d: 0, inside: inside }

  d := Max(Abs(px - absX), Abs(py - absY))
  if (d <= 6)                        ; 两路完全吻合
    return { ok: true, x: px, y: py, src: "双证一致", d: d, inside: true }
  if (inside)                        ; 窗口挪过，相对依然可信
    return { ok: true, x: px, y: py, src: "窗口位移→相对", d: d, inside: true }
  return { ok: true, x: absX, y: absY, src: "相对越界→绝对", d: d, inside: false }
}

; 统一的退出入口：把窗口层级还原，避免 ERP 一直压在最上面
Done(code) {
  global gMain, gMoved, gOrig
  try WinSetAlwaysOnTop 0, "ahk_id " gMain
  ; 归位过就把窗口放回用户原来的位置，别打扰他
  try {
    if (gMoved && gOrig && gOrig.w > 0)
      WinMove gOrig.x, gOrig.y, gOrig.w, gOrig.h, "ahk_id " gMain
  }
  ExitApp code
}

ClickAt(key) {
  p := Resolve(key)
  if !p.ok
    return false
  if (p.src != "双证一致")
    Log("  坐标 " key "：" p.src "（偏差 " p.d "px，用 " p.x "," p.y "）")
  Click p.x, p.y
  Sleep 400
  return true
}

ClickRight(key) {
  p := Resolve(key)
  if !p.ok
    return false
  if (p.src != "双证一致")
    Log("  坐标 " key "：" p.src "（偏差 " p.d "px）")
  Click p.x, p.y, "Right"
  Sleep 600
  return true
}

/* ---------------- 校验模式：只报告，不动鼠标 ---------------- */
if VERIFY {
  WinGetPos &wx, &wy, &ww, &wh, "ahk_id " main
  WinGetClientPos &cx, &cy, &cw, &ch, "ahk_id " main
  rW := IniRead(CoordFile, "window", "w", ""), rH := IniRead(CoordFile, "window", "h", "")
  rCx := IniRead(CoordFile, "window", "clientX", ""), rCy := IniRead(CoordFile, "window", "clientY", "")
  dpi := IniRead(CoordFile, "window", "dpi", "")
  cal := IniRead(CoordFile, "window", "calibrated", "")

  out := ""
  out .= "校准时间：" cal "`n"
  out .= "窗口尺寸：校准 " rW "x" rH " → 当前 " ww "x" wh "`n"
  out .= "客户区原点：校准 " rCx "," rCy " → 当前 " cx "," cy "`n"
  out .= "DPI：校准 " dpi " → 当前 " A_ScreenDPI "`n`n"
  out .= "序号`t点位`t相对`t绝对`t换算`t偏差`t判定`n"

  i := 0, bad := 0, moved := 0
  for k in KEYS {
    i += 1
    p := Resolve(k)
    if !p.ok {
      out .= i "`t" k "`t—`t—`t—`t—`t缺失`n"
      continue
    }
    relTxt := Rel(k "X") != "" ? Rel(k "X") "," Rel(k "Y") : "—"
    absTxt := AbsC(k "X") != "" ? AbsC(k "X") "," AbsC(k "Y") : "—"
    if (p.src = "相对越界→绝对") {
      bad += 1
    } else if (p.src = "窗口位移→相对") {
      moved += 1
    }
    out .= i "`t" k "`t" relTxt "`t" absTxt "`t" p.x "," p.y "`t" p.d "`t" p.src "`n"
  }
  if (rW != "" && (Abs(ww - rW) > 60 || Abs(wh - rH) > 60)) {
    out .= "`n⚠ 窗口尺寸与校准差异较大，布局可能已变，建议重新校准。`n"
    bad += 1
  }
  if (dpi != "" && dpi != A_ScreenDPI) {
    out .= "`n⚠ 屏幕 DPI 变化（" dpi " → " A_ScreenDPI "），绝对坐标会整体偏移，需重新校准。`n"
    bad += 1
  }
  if bad
    verdict := "有 " bad " 项需要重校准"
  else if moved
    verdict := "窗口有位移，相对坐标已自动跟随（" moved " 项）"
  else
    verdict := "双证全部一致"
  out .= "`n结论：" verdict

  ; FileDelete 对不存在的文件会抛错并卡住脚本，必须先判存在
  if FileExist(CheckFile)
    FileDelete CheckFile
  FileAppend out, CheckFile, "UTF-8"
  Done(bad ? 3 : 0)
}

/* ---------------- 正式导出 ---------------- */
; 窗口几何归一化：校准是在固定位置/尺寸下取的坐标。
; 实测踩过坑：窗口跑到 x=1457（屏幕只有 1920 宽），点击全部落到屏幕外，导出静默失败。
rx := IniRead(CoordFile, "window", "x", ""), ry := IniRead(CoordFile, "window", "y", "")
rW := IniRead(CoordFile, "window", "w", ""), rH := IniRead(CoordFile, "window", "h", "")
WinGetPos &ox, &oy, &ow, &oh, "ahk_id " main
gOrig := { x: ox, y: oy, w: ow, h: oh }
gMoved := false
if (rx != "" && rW != ""
  && (Abs(ox - rx) > 8 || Abs(oy - ry) > 8 || Abs(ow - rW) > 8 || Abs(oh - rH) > 8)) {
  WinMove rx, ry, rW, rH, "ahk_id " main
  Sleep 900
  gMoved := true
  Log("窗口归位：原 " ox "," oy " " ow "x" oh " → " rx "," ry " " rW "x" rH)
}

; 别的窗口（含本助手）可能盖在 ERP 前面，点击会打偏 —— 临时置顶，退出时还原
WinSetAlwaysOnTop 1, "ahk_id " main
WinActivate "ahk_id " main
WinWaitActive "ahk_id " main,,5
Sleep 600
WinGetPos &wx, &wy, &ww, &wh, "ahk_id " main
WinGetClientPos &cx, &cy, &cw, &ch, "ahk_id " main
Log("窗口 " wx "," wy " " ww "x" wh "；客户区 " cx "," cy " " cw "x" ch "；期间 " FROM " ~ " TO)

; 1) 统计 → 销售 → 销售日统计
ClickAt("menu")
ClickAt("sale")
ClickAt("daily")
Sleep 2000

; 2) 选日期
ClickAt("from")
Send "^a"
Sleep 150
SendText FROM
Sleep 250
Send "{Enter}"
Sleep 350
if Has("fromok")
  ClickAt("fromok")

ClickAt("to")
Send "^a"
Sleep 150
SendText TO
Sleep 250
Send "{Enter}"
Sleep 350
if Has("took")
  ClickAt("took")

; 3) 搜索
ClickAt("search")
Sleep 3000

; 4) 表头右键 → 导出
ClickRight("header")
ClickAt("export")
; 导出弹窗是 CEF 新开的窗口，1 秒内不一定渲染完；等它真的出现再点按钮
if !WinWait("导出",, 10) {
  Log("未出现「导出」弹窗，流程中止")
  Done(3)
}
Sleep 900

; 5) 导出弹窗：模板 → 导出
if Has("tpl") {
  ClickAt("tpl")
  Sleep 400
}
; 导出按钮若没校准过，用回车触发弹窗默认按钮（比猜坐标稳）
if !ClickAt("ok") {
  Log("  未校准「导出」按钮，改用 Enter 触发默认按钮")
  Send "{Enter}"
}
Sleep 1800

; 6) 另存为：文件名框自带焦点，直接输完整路径
if !WinWaitActive("ahk_class #32770",,12) {
  Log("未出现另存为窗口")
  Done(2)
}
Sleep 800
outFile := OUT_DIR "\销售订单-" TO ".csv"
if !DirExist(OUT_DIR)
  DirCreate OUT_DIR

; 文件名框默认聚焦，先试着只填文件名（对话框一般已在目标目录）
SendText "销售订单-" TO ".csv"
Sleep 600
Send "{Enter}"
Sleep 2000

; 若是标准另存为（可能要求完整路径），用控件写入兜底
if WinExist("另存为") {
  hDlg := WinExist("另存为")
  ControlSetText "销售订单-" TO ".csv", "Edit1", "ahk_id " hDlg
  Sleep 400
  WinActivate "ahk_id " hDlg
  Sleep 200
  Send "{Enter}"
  Sleep 2200
}

; ERP 保存后会弹「导出成功，是否立即打开文件？」—— 选「否」，否则会把 CSV 甩给 Excel
if WinWait("旺店通管理系统",, 10) {
  hMsg := WinExist("旺店通管理系统")
  WinActivate "ahk_id " hMsg
  Sleep 300
  ControlSend "!n",, "ahk_id " hMsg      ; 否(&N)
  Sleep 600
  if WinExist("ahk_id " hMsg) {
    Send "{Esc}"
    Sleep 400
  }
  Log("已应答「导出成功」提示（不打开文件）")
}

if FileExist(outFile) {
  Log("已导出：" outFile)
  Done(0)
}

; 文件不在预期位置：给出目录里最新的 csv，方便排查
newest := ""
newestTime := ""
try {
  Loop Files, OUT_DIR "\*.csv" {
    if (A_LoopFileTimeModified > newestTime) {
      newestTime := A_LoopFileTimeModified
      newest := A_LoopFileFullPath
    }
  }
}
Log("导出未落到预期路径：" outFile "；目录最新：" (newest = "" ? "无" : newest))
Done(4)
