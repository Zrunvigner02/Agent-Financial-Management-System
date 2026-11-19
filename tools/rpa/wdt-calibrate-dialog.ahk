#Requires AutoHotkey v2.0
#SingleInstance Force
; ============================================================
; 补录导出弹窗内的两个点（模板 / 导出按钮）
;   弹窗已经开着的时候运行最好
;   F8 = 记录当前点    F9 = 跳过    Esc = 退出
; 相对坐标以「旺店通主窗口客户区左上角」为原点，与既有点位同一套基准
; ============================================================
SetWorkingDir A_ScriptDir
CoordMode "Mouse", "Screen"
CoordFile := A_ScriptDir "\wdt-coords.ini"
WIN := "ahk_exe 旺店通ERP旗舰版.exe"

STEPS := [
  ["tpl", "① 弹窗里的「模板1」按钮；这版没有就按 F9"],
  ["ok",  "② 弹窗右下角「导出」按钮"]
]

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
  MsgBox "请先打开旺店通 ERP。", "振颜丽舍"
  ExitApp
}
WinGetClientPos &CX, &CY, &CW, &CH, "ahk_id " main
IniWrite CX, CoordFile, "window", "clientX"
IniWrite CY, CoordFile, "window", "clientY"
IniWrite CW, CoordFile, "window", "clientW"
IniWrite CH, CoordFile, "window", "clientH"
IniWrite A_ScreenDPI, CoordFile, "window", "dpi"

idx := 1
Show()

Show() {
  global idx, STEPS, CX, CY
  if (idx > STEPS.Length) {
    ToolTip
    MsgBox "补录完成：模板与导出按钮已记录（绝对 + 相对各一份）。", "振颜丽舍"
    ExitApp
  }
  hint := ""
  try {
    MouseGetPos &mx, &my
    hint := "`n相对客户区：(" (mx - CX) ", " (my - CY) ")"
  }
  ToolTip "补录 " idx "/2`n" STEPS[idx][2] hint "`n`nF8=记录  F9=跳过  Esc=退出"
}

F8:: {
  global idx, STEPS, CoordFile, CX, CY
  MouseGetPos &sx, &sy
  key := STEPS[idx][1]
  IniWrite sx, CoordFile, "abs", key "X"
  IniWrite sy, CoordFile, "abs", key "Y"
  IniWrite (sx - CX), CoordFile, "coords", key "X"
  IniWrite (sy - CY), CoordFile, "coords", key "Y"
  idx += 1
  Show()
}

F9:: {
  global idx
  idx += 1
  Show()
}

Esc::{
  ToolTip
  ExitApp
}
