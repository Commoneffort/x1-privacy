#!/usr/bin/env python3
"""Render docs/whitepaper.html to ui/public/whitepaper.pdf (needs Python Playwright + Chromium)."""
import os
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "whitepaper.html")
OUT = os.path.join(HERE, "..", "ui", "public", "whitepaper.pdf")
FOOTER = ('<div style="width:100%;font-size:8px;color:#8a9bb4;padding:0 20mm;display:flex;justify-content:space-between;'
          'font-family:Helvetica,Arial,sans-serif"><span>X1 Privacy — Whitepaper v1.1</span>'
          '<span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>')

with sync_playwright() as pw:
    browser = pw.chromium.launch(args=["--no-sandbox"])
    page = browser.new_page()
    page.goto("file://" + SRC)
    page.emulate_media(media="print")
    page.pdf(path=OUT, format="A4", print_background=True, display_header_footer=True,
             header_template="<span></span>", footer_template=FOOTER,
             margin={"top": "22mm", "bottom": "20mm", "left": "20mm", "right": "20mm"})
    browser.close()
print("wrote", os.path.normpath(OUT))
