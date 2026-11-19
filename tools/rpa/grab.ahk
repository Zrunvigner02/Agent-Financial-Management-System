#Requires AutoHotkey v2.0
#SingleInstance Off
; 抓屏幕矩形存 BMP：grab.ahk x y w h out.bmp
; 纯 Win32 DllCall（无 .NET、无 GDI+ 库）
DllCall("user32\SetProcessDPIAware")
x := A_Args[1] + 0
y := A_Args[2] + 0
w := A_Args[3] + 0
h := A_Args[4] + 0
out := A_Args[5]

hdc := DllCall("user32\GetDC", "Ptr", 0, "Ptr")
mem := DllCall("gdi32\CreateCompatibleDC", "Ptr", hdc, "Ptr")
bm := DllCall("gdi32\CreateCompatibleBitmap", "Ptr", hdc, "Int", w, "Int", h, "Ptr")
DllCall("gdi32\SelectObject", "Ptr", mem, "Ptr", bm)
DllCall("gdi32\BitBlt", "Ptr", mem, "Int", 0, "Int", 0, "Int", w, "Int", h,
  "Ptr", hdc, "Int", x, "Int", y, "UInt", 0x00CC0020)

stride := ((w * 3 + 3) // 4) * 4
dataSize := stride * h
bmi := Buffer(40, 0)
NumPut("UInt", 40, bmi, 0)
NumPut("Int", w, bmi, 4)
NumPut("Int", -h, bmi, 8)
NumPut("UShort", 1, bmi, 12)
NumPut("UShort", 24, bmi, 14)
NumPut("UInt", 0, bmi, 16)
NumPut("UInt", dataSize, bmi, 20)
pix := Buffer(dataSize, 0)
DllCall("gdi32\GetDIBits", "Ptr", mem, "Ptr", bm, "UInt", 0, "UInt", h,
  "Ptr", pix, "Ptr", bmi, "UInt", 0)

bmpbuf := Buffer(54 + dataSize, 0)
NumPut("UShort", 0x4D42, bmpbuf, 0)
NumPut("UInt", 54 + dataSize, bmpbuf, 2)
NumPut("UInt", 54, bmpbuf, 10)
DllCall("RtlMoveMemory", "Ptr", bmpbuf.Ptr + 14, "Ptr", bmi.Ptr, "UPtr", 40)
DllCall("RtlMoveMemory", "Ptr", bmpbuf.Ptr + 54, "Ptr", pix.Ptr, "UPtr", dataSize)
f := FileOpen(out, "w")
f.RawWrite(bmpbuf, 54 + dataSize)
f.Close()

DllCall("gdi32\DeleteObject", "Ptr", bm)
DllCall("gdi32\DeleteDC", "Ptr", mem)
DllCall("user32\ReleaseDC", "Ptr", 0, "Ptr", hdc)
ExitApp 0
