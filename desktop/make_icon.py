# -*- coding: utf-8 -*-
"""生成「振颜丽舍」桌面端图标：美妆（粉饼盘 / 口红 / 珠光）+ 财务（¥）。
零第三方依赖，仅 Pillow。
输出: desktop/icon.ico, desktop/icon.png, upstream/favicon.ico, upstream/favicon.png
"""
import os
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DESK = os.path.join(ROOT, 'desktop')
UP = os.path.join(ROOT, 'upstream')
S = 1024  # 4x 超采样，目标 256

ROSE_L = (252, 205, 220)   # 左上：柔雾玫瑰
ROSE_M = (218, 112, 152)   # 中段：胭脂粉
PLUM = (116, 42, 84)       # 右下：深梅紫
GOLD = (238, 198, 126)     # 香槟金
CREAM = (255, 249, 245)    # 粉饼盘奶白
LIP = (212, 56, 98)        # 口红膏体


def lerp(a, b, t):
    return int(a + (b - a) * t)


def mix(c0, c1, t):
    return tuple(lerp(c0[i], c1[i], t) for i in range(3))


def gradient():
    base = Image.new('RGBA', (S, S))
    px = base.load()
    for y in range(S):
        for x in range(S):
            t = min(1.0, max(0.0, (x * 0.55 + y * 0.80) / (S * 1.35)))
            c = mix(ROSE_L, ROSE_M, t / 0.58) if t < 0.58 else \
                mix(ROSE_M, PLUM, (t - 0.58) / 0.42)
            px[x, y] = (c[0], c[1], c[2], 255)

    glow = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse((-260, -420, 720, 420), fill=(255, 255, 255, 92))
    glow = glow.filter(ImageFilter.GaussianBlur(120))
    return Image.alpha_composite(base, glow)


def load_font():
    for fp in (r'C:\Windows\Fonts\arialbd.ttf',
               r'C:\Windows\Fonts\segoeuib.ttf',
               r'C:\Windows\Fonts\msyhbd.ttc'):
        if os.path.exists(fp):
            try:
                return ImageFont.truetype(fp, 430)
            except Exception:
                pass
    return ImageFont.load_default()


def powder_case(d):
    """中央粉饼盘：香槟金外圈 + 奶白盘面 + ¥ 财务符号。"""
    d.ellipse((206, 156, 818, 768), fill=GOLD + (255,))
    d.ellipse((224, 174, 800, 750), fill=(246, 214, 168, 255))
    d.ellipse((238, 188, 786, 736), fill=CREAM + (255,))
    d.ellipse((258, 208, 766, 716), outline=(226, 186, 198, 130), width=5)
    d.arc((258, 208, 766, 716), 196, 268, fill=(255, 255, 255, 220), width=16)

    font = load_font()
    text = '\u00A5'
    box = d.textbbox((0, 0), text, font=font)
    tw, th = box[2] - box[0], box[3] - box[1]
    tx = (S - tw) / 2 - box[0]
    ty = (S - th) / 2 - box[1] - 42
    d.text((tx + 10, ty + 14), text, font=font, fill=(150, 96, 116, 90))
    d.text((tx, ty), text, font=font, fill=PLUM + (255,))


def lipstick():
    """斜插的口红：玫红膏体 + 香槟金管身。"""
    im = Image.new('RGBA', (180, 470), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.polygon([(42, 126), (42, 26), (138, 8), (138, 126)], fill=LIP + (255,))
    d.polygon([(54, 126), (54, 30), (76, 26), (76, 126)], fill=(246, 142, 168, 130))
    d.rectangle((32, 126, 148, 182), fill=(232, 206, 160, 255))
    d.rectangle((32, 126, 148, 140), fill=(255, 238, 206, 255))
    d.rounded_rectangle((24, 182, 156, 444), radius=18, fill=(214, 166, 96, 255))
    d.rectangle((44, 188, 66, 438), fill=(255, 230, 176, 110))
    d.rectangle((138, 188, 152, 438), fill=(116, 68, 42, 80))
    d.rounded_rectangle((24, 412, 156, 452), radius=12, fill=(176, 126, 70, 255))
    return im.rotate(-34, resample=Image.BICUBIC, expand=True)


def build():
    base = gradient()
    d = ImageDraw.Draw(base)

    # 背景柔弧（扫粉的弧度感）
    for i, alpha in enumerate((70, 48, 30)):
        y0 = 830 + i * 40
        d.arc((-140, y0 - 170, S + 140, y0 + 250), 198, 342,
              fill=(255, 240, 220, alpha), width=12)

    powder_case(d)

    # 珠光散粉点
    for x, y, r, a in ((150, 250, 13, 190), (196, 196, 8, 150),
                       (128, 330, 7, 130), (860, 200, 10, 170),
                       (900, 268, 6, 130), (842, 836, 9, 150)):
        d.ellipse((x - r, y - r, x + r, y + r), fill=(255, 248, 226, a))

    # 口红（带柔和投影）
    ls = lipstick()
    shadow = Image.new('RGBA', ls.size, (90, 24, 56, 255))
    alpha = ls.getchannel('A').filter(ImageFilter.GaussianBlur(14))
    shadow.putalpha(alpha.point(lambda v: int(v * 0.42)))
    base.alpha_composite(shadow, (598, 568))
    base.alpha_composite(ls, (588, 556))

    d = ImageDraw.Draw(base)
    d.rounded_rectangle((40, 40, S - 40, S - 40), radius=200,
                        outline=(255, 232, 190, 165), width=8)

    mask = Image.new('L', (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle((16, 16, S - 16, S - 16), radius=224, fill=255)
    base.putalpha(mask)
    return base


def main():
    img = build()
    png256 = img.resize((256, 256), Image.LANCZOS)
    ico = os.path.join(DESK, 'icon.ico')
    png256.save(ico, format='ICO',
                sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    png256.save(os.path.join(DESK, 'icon.png'))
    # 桌面快捷方式专用副本：独立文件名。Explorer 会按 ico 路径缓存图标位图，
    # 覆盖同名 icon.ico 后旧缓存不会失效；用新路径可强制重新提取。
    shortcut_ico = os.path.join(DESK, 'zhuangdian-icon.ico')
    png256.save(shortcut_ico, format='ICO',
                sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print('zhuangdian-icon.ico:', os.path.getsize(shortcut_ico), 'bytes')
    os.makedirs(UP, exist_ok=True)
    img.resize((64, 64), Image.LANCZOS).save(os.path.join(UP, 'favicon.ico'), format='ICO',
                                             sizes=[(16, 16), (32, 32), (48, 48), (64, 64)])
    img.resize((128, 128), Image.LANCZOS).save(os.path.join(UP, 'favicon.png'))
    print('icon.ico:', os.path.getsize(ico), 'bytes')
    print('favicon.ico:', os.path.getsize(os.path.join(UP, 'favicon.ico')), 'bytes')


if __name__ == '__main__':
    main()
