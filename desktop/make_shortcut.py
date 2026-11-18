"""直接按 MS-SHLLINK 规范写出 .lnk 二进制（不调用 COM / WScript.Shell）。
用法: python make_shortcut.py [输出.lnk路径]
"""
import os
import struct
import sys
import ctypes
from ctypes import wintypes

DESK = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(DESK)
TARGET = r'C:\Users\zylspc\.workbuddy\binaries\python\versions\3.13.12\pythonw.exe'
ARGS = '"' + os.path.join(DESK, 'launcher.pyw') + '"'
WORKDIR = DESK
# 用独立文件名的 ico：避开 Explorer 对 desktop/icon.ico 的旧图标缓存（2026-11-11）
ICON = os.path.join(DESK, 'zhuangdian-icon.ico')
NAME = '妆点管账 · 本地离线版'

# LinkFlags
HAS_LINK_TARGET_ID_LIST = 0x00000001
HAS_LINK_INFO = 0x00000002
HAS_NAME = 0x00000004
HAS_WORKING_DIR = 0x00000010
HAS_ARGUMENTS = 0x00000020
HAS_ICON_LOCATION = 0x00000040
IS_UNICODE = 0x00000080
FLAGS = (HAS_LINK_TARGET_ID_LIST | HAS_LINK_INFO | HAS_NAME | HAS_WORKING_DIR
         | HAS_ARGUMENTS | HAS_ICON_LOCATION | IS_UNICODE)


def utf16_string(s):
    data = s.encode('utf-16-le')
    return struct.pack('<H', len(s)) + data


def real_id_list(path):
    """用 shell32 的路径解析 API 生成合法 PIDL 字节串（纯数据构造，不执行外部程序）。"""
    try:
        shell32 = ctypes.WinDLL('shell32', use_last_error=True)
        create = shell32.ILCreateFromPathW
        create.argtypes = [wintypes.LPCWSTR]
        create.restype = ctypes.c_void_p
        il_size = shell32.ILGetSize
        il_size.argtypes = [ctypes.c_void_p]
        il_size.restype = wintypes.UINT
        il_free = shell32.ILFree
        il_free.argtypes = [ctypes.c_void_p]
        pidl = create(path)
        if not pidl:
            return None
        size = il_size(pidl)
        buf = ctypes.create_string_buffer(size)
        ctypes.memmove(buf, pidl, size)
        il_free(pidl)
        return struct.pack('<H', size) + buf.raw[:size]
    except Exception as exc:
        sys.stderr.write('IDList fallback: %r\n' % (exc,))
        return None


def link_info(path):
    ansi = path.encode('mbcs') + b'\x00'
    suffix = b'\x00'
    label = b'\x00'
    volume_id = struct.pack('<IIII', 16 + len(label), 3, 0, 0x10) + label
    header_size = 0x1C
    volume_offset = header_size
    base_offset = volume_offset + len(volume_id)
    suffix_offset = base_offset + len(ansi)
    body = (struct.pack('<IIIIIII', 0, header_size, 1,
                        volume_offset, base_offset, 0, suffix_offset)
            + volume_id + ansi + suffix)
    size = len(body)
    return struct.pack('<I', size) + body[4:]


def build_lnk():
    clsid = bytes.fromhex('0114020000000000c000000000000046')
    header = struct.pack('<I', 0x4C) + clsid + struct.pack(
        '<IIQQQIIIHHII',
        FLAGS,          # LinkFlags
        0x20,           # FileAttributes = ARCHIVE
        0, 0, 0,        # Creation / Access / Write FILETIME
        0,              # FileSize
        0,              # IconIndex
        1,              # ShowCommand = SW_SHOWNORMAL
        0,              # HotKey
        0,              # Reserved1
        0, 0,           # Reserved2 / Reserved3
    )
    assert len(header) == 76, len(header)
    strings = (utf16_string(NAME)
               + utf16_string(WORKDIR)
               + utf16_string(ARGS)
               + utf16_string(ICON))
    id_list = real_id_list(TARGET)
    if id_list is None:  # 极端情况下退回空 IDList
        sys.stderr.write('WARN: 使用空 IDList，Shell 可能无法解析目标\n')
        id_list = struct.pack('<H', 2) + b'\x00\x00'
    return header + id_list + link_info(TARGET) + strings + struct.pack('<I', 0)


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        os.environ.get('USERPROFILE', ''), 'Desktop', '妆点管账.lnk')
    data = build_lnk()
    with open(out, 'wb') as f:
        f.write(data)
    print('LNK:', out)
    print('bytes:', len(data))
    print('target:', TARGET)
    print('args:', ARGS)
    print('icon:', ICON)


if __name__ == '__main__':
    main()
