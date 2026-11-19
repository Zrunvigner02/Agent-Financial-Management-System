#Requires AutoHotkey v2.0
#SingleInstance Force
; ============================================================
; 旺店通导出坐标校准（绝对 + 相对 双记录）
;
;   每次记录同时写两份：
;     [abs]    = 屏幕绝对坐标（校准那一刻）
;     [coords] = 相对主窗口「客户区左上角」的偏移（跟着窗口移动）
;   再加 [window] 里的客户区原点、尺寸、DPI，
;   运行时两路各算一个点互相印证，谁不可信就换另一个。
;
;   F8 = 记录    F9 = 跳过    Esc = 退出
; ============================================================
SetWorkingDir A_ScriptDir
CoordMode "Mouse", "Screen"          ; 取点一律用屏幕坐标，不依赖活动窗口
CoordFile := A_ScriptDir "\wdt-coords.ini"
WIN := "ahk_exe 旺店通ERP旗舰版.exe"

STEPS := [
  ["menu",   "① 顶部菜单「统计」"],
  ["sale",   "② 子菜单「销售」"],
  ["daily",  "③「销售日统计」"],
  ["from",   "④ 开始日期输入框"],
  ["fromok", "⑤ 日历确定（无则 F9）"],
  ["to",     "⑥ 结束日期输入框"],
  ["took",   "⑦ 结束日期日历确定（无则 F9）"],
  ["search", "⑧ 蓝色「搜索」按钮"],
  ["header", "⑨ 表格「日期」表头"],
  ["export", "⑩ 右键菜单「导出...」"],
  ["tpl",    "⑪ 导出弹窗「模板1」（无则 F9）"],
  ["ok",     "⑫ 导出弹窗「导出」按钮"]
]
; 可跳过的步骤（弹窗形态因版本而异）
OPTIONAL := Map("fromok", 1, "took", 1, "tpl", 1)

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
if !main {
  MsgBox "请先打开旺店通 ERP，再运行校准。", "振颜丽舍"
  ExitApp
}
WinActivate "ahk_id " main
WinWaitActive "ahk_id " main,,3
Sleep 300

; ---- 记录窗口基准（含客户区原点，相对坐标就以它为 0,0） ----
WinGetPos &WX, &WY, &WW, &WH, "ahk_id " main
WinGetClientPos &CX, &CY, &CW, &CH, "ahk_id " main
IniWrite WX, CoordFile, "window", "x"
IniWrite WY, CoordFile, "window", "y"
IniWrite WW, CoordFile, "window", "w"
IniWrite WH, CoordFile, "window", "h"
IniWrite CX, CoordFile, "window", "clientX"
IniWrite CY, CoordFile, "window", "clientY"
IniWrite CW, CoordFile, "window", "clientW"
IniWrite CH, CoordFile, "window", "clientH"
IniWrite A_ScreenDPI, CoordFile, "window", "dpi"
IniWrite FormatTime(A_Now, "yyyy-MM-dd HH:mm:ss"), CoordFile, "window", "calibrated"

idx := 1
Show()

Show() {
  global idx, STEPS, CoordFile, OPTIONAL, CX, CY
  if (idx > STEPS.Length) {
    missing := []
    for s in STEPS {
      if OPTIONAL.Has(s[1])
        continue
      if (IniRead(CoordFile, "coords", s[1] "X", "") = "")
        missing.Push(s[2])
    }
    if missing.Length
      MsgBox "还缺这些位置，请重跑校准：`n`n" JoinArr(missing, "`n"), "振颜丽舍"
    else
      MsgBox "校准完成：12 项已记录，绝对与相对各一份。`n`n接着可跑：npm run wdt:verify", "振颜丽舍"
    ExitApp
  }
  hint := ""
  try {
    MouseGetPos &mx, &my
    hint := "`n当前相对客户区：(" (mx - CX) ", " (my - CY) ")"
  }
  ToolTip "校准 " idx "/12`n" STEPS[idx][2] hint "`n`nF8=记录  F9=跳过  Esc=退出"
}

JoinArr(a, sep) {
  out := ""
  for i, v in a
    out .= (i > 1 ? sep : "") v
  return out
}

F8:: {
  global idx, STEPS, CoordFile, CX, CY
  MouseGetPos &sx, &sy                                  ; 屏幕绝对
  key := STEPS[idx][1]
  IniWrite sx, CoordFile, "abs", key "X"
  IniWrite sy, CoordFile, "abs", key "Y"
  IniWrite (sx - CX), CoordFile, "coords", key "X"       ; 相对客户区
  IniWrite (sy - CY), CoordFile, "coords", key "Y"
  idx += 1
  Show()
}

F9:: {
  global idx
  idx += 1
  Show()
}

Esc::ExitApp
