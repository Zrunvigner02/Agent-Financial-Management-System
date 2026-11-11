"""把表格渲染成 PDF / PNG / JPG / WEBP（位图，中文用系统微软雅黑，保证不乱码）。

由 tools/filee-bridge.mjs 调用：
    python tools/render_image.py <out_path> <ext>
stdin: UTF-8 JSON {"title":..., "period":..., "headers":[...], "rows":[[...],...]}
stdout: UTF-8 JSON {"ok":true,"bytes":...,"pages":...}
"""
import sys
import os
import json
import datetime
from PIL import Image, ImageDraw, ImageFont

FONT_CANDIDATES = [
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\simsun.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
]
FONT_PATH = next((p for p in FONT_CANDIDATES if os.path.isfile(p)), None)

INK = (74, 36, 56)
PLUM = (116, 42, 84)
HEAD_BG = (248, 231, 239)
GRID = (234, 217, 226)
ZEBRA = (255, 251, 253)
WHITE = (255, 255, 255)


def font(size):
    if FONT_PATH:
        return ImageFont.truetype(FONT_PATH, size)
    return ImageFont.load_default()


def clip(text, f, max_w):
    s = "" if text is None else str(text)
    s = s.replace("\r", " ").replace("\n", " ")
    if f.getlength(s) <= max_w:
        return s
    out = ""
    for ch in s:
        if f.getlength(out + ch + "…") > max_w:
            break
        out += ch
    return (out + "…") if out else "…"


def main():
    out, ext = sys.argv[1], sys.argv[2].lower().lstrip(".")
    payload = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    title = str(payload.get("title") or "报表")
    period = str(payload.get("period") or "")
    headers = [str(x) for x in (payload.get("headers") or [])] or ["内容"]
    rows = [[str(c) if c is not None else "" for c in r] for r in (payload.get("rows") or [])]
    if not rows:
        rows = [["（本期暂无数据）"] + [""] * (len(headers) - 1)]

    f_title = font(26)
    f_meta = font(13)
    f_head = font(15)
    f_cell = font(14)

    pad = 12
    widths = []
    for i, h in enumerate(headers):
        w = f_head.getlength(h)
        for r in rows[:400]:
            if i < len(r):
                w = max(w, f_cell.getlength(r[i]))
        widths.append(min(300, max(90, int(w + pad * 2))))
    max_total = 1680
    if sum(widths) > max_total:
        scale = max_total / sum(widths)
        widths = [max(70, int(w * scale)) for w in widths]

    margin = 24
    row_h, head_h, top_h = 32, 38, 88
    table_w = sum(widths)
    canvas_w = table_w + margin * 2
    rows_per_page = max(1, (980 - top_h - head_h - margin) // row_h)
    chunks = [rows[i:i + rows_per_page] for i in range(0, len(rows), rows_per_page)] or [[]]

    def draw_page(page_rows, page_no, page_count):
        h = top_h + head_h + len(page_rows) * row_h + margin + 26
        im = Image.new("RGB", (canvas_w, h), WHITE)
        d = ImageDraw.Draw(im)
        d.rectangle((0, 0, canvas_w, 6), fill=PLUM)
        d.text((margin, 20), clip(title, f_title, table_w), font=f_title, fill=PLUM)
        stamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
        sub = "振颜丽舍 · 妆点管账"
        if period:
            sub += " ｜ 期间 " + period
        sub += " ｜ " + stamp + " ｜ 第 %d/%d 页" % (page_no, page_count)
        d.text((margin, 58), clip(sub, f_meta, table_w), font=f_meta, fill=(150, 102, 126))

        y0 = top_h
        d.rectangle((margin, y0, margin + table_w, y0 + head_h), fill=HEAD_BG)
        x = margin
        for i, (h_txt, w) in enumerate(zip(headers, widths)):
            d.text((x + pad, y0 + 9), clip(h_txt, f_head, w - pad * 2), font=f_head, fill=PLUM)
            x += w
            d.line((x, y0, x, y0 + head_h), fill=GRID)

        for ri, row in enumerate(page_rows):
            y = y0 + head_h + ri * row_h
            if ri % 2 == 1:
                d.rectangle((margin, y, margin + table_w, y + row_h), fill=ZEBRA)
            x = margin
            for i, w in enumerate(widths):
                val = row[i] if i < len(row) else ""
                d.text((x + pad, y + 7), clip(val, f_cell, w - pad * 2), font=f_cell, fill=INK)
                x += w
                d.line((x, y, x, y + row_h), fill=GRID)
            d.line((margin, y + row_h, margin + table_w, y + row_h), fill=GRID)
        d.line((margin, y0, margin + table_w, y0), fill=GRID)
        d.line((margin, y0 + head_h, margin + table_w, y0 + head_h), fill=GRID)
        d.rectangle((margin, y0, margin + table_w, y0 + head_h + len(page_rows) * row_h), outline=GRID)
        return im

    pages = [draw_page(c, i + 1, len(chunks)) for i, c in enumerate(chunks)]

    if ext == "pdf":
        pages[0].save(out, "PDF", resolution=150.0, save_all=True,
                      append_images=pages[1:] if len(pages) > 1 else [])
    else:
        # 位图格式把多页纵向拼成一张长图，避免只导出第一页造成数据缺失
        if len(pages) > 1:
            total_h = sum(p.height for p in pages)
            merged = Image.new("RGB", (pages[0].width, total_h), WHITE)
            y = 0
            for p in pages:
                merged.paste(p, (0, y))
                y += p.height
            im = merged
        else:
            im = pages[0]
        if ext in ("jpg", "jpeg"):
            im.save(out, "JPEG", quality=88)
        elif ext == "webp":
            im.save(out, "WEBP", quality=88)
        else:
            im.save(out, "PNG")

    print(json.dumps({"ok": True, "bytes": os.path.getsize(out), "pages": len(pages)},
                     ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # 错误详情回传给 Node 侧，避免静默失败
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        sys.exit(1)
