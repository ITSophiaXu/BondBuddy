import io
import os
import unittest
import zipfile
from datetime import date

from bondbuddy_update import docx_model, items, periods, plan_builder, tables
from bondbuddy_update.periods import Period, parse_period, plan_periods


class PeriodTests(unittest.TestCase):
    def test_parse(self):
        self.assertEqual(parse_period("2025年9月末"), Period(date(2025, 9, 30), "point"))
        self.assertEqual(parse_period("2025年1-9月"), Period(date(2025, 9, 30), "flow"))
        self.assertEqual(parse_period("2024年末"), Period(date(2024, 12, 31), "point"))
        self.assertEqual(parse_period("2024年度"), Period(date(2024, 12, 31), "flow"))
        self.assertEqual(parse_period("2025年6月30日"), Period(date(2025, 6, 30), "point"))
        self.assertIsNone(parse_period("2025年6月15日"))
        self.assertIsNone(parse_period("项目"))

    def test_plan_modes(self):
        p = plan_periods([Period(date(2025, 6, 30), "point"), Period(date(2024, 12, 31), "point"),
                          Period(date(2023, 12, 31), "point")], date(2025, 9, 30))
        self.assertEqual(p.mode, "replace_latest")
        self.assertEqual(p.new_for(Period(date(2025, 6, 30), "flow")), Period(date(2025, 9, 30), "flow"))
        self.assertEqual(p.new_for(Period(date(2024, 12, 31), "point")), Period(date(2024, 12, 31), "point"))
        p = plan_periods([Period(date(2023, 6, 30), "point"), Period(date(2022, 12, 31), "point"),
                          Period(date(2021, 12, 31), "point")], date(2024, 6, 30))
        self.assertEqual(p.mode, "roll")
        p = plan_periods([Period(date(2020, 12, 31), "point"), Period(date(2019, 12, 31), "point")], date(2023, 6, 30))
        self.assertEqual(p.mode, "replace_all")
        with self.assertRaises(ValueError):
            plan_periods([Period(date(2025, 6, 30), "point")], date(2025, 3, 31))

    def test_relabel_keeps_style(self):
        p = plan_periods([Period(date(2025, 6, 30), "point"), Period(date(2024, 12, 31), "point"),
                          Period(date(2023, 12, 31), "point")], date(2025, 9, 30))
        self.assertEqual(tables._replace_periods_full("截至2025年6月末，2025年1-6月", p), "截至2025年9月末，2025年1-9月")
        self.assertEqual(tables._replace_periods_full("2025年1-6月/6月末", p), "2025年1-9月/9月末")
        self.assertEqual(tables._replace_periods_full("截至2025年6月30日", p), "截至2025年9月30日")
        self.assertEqual(tables._replace_periods_full("2024年末较2023年末", p), "2024年末较2023年末")


class ItemTests(unittest.TestCase):
    def test_normalize(self):
        self.assertEqual(items.normalize("  四、利润总额（亏损总额以“－”号填列）"), "利润总额")
        self.assertEqual(items.normalize("        其中：应收账款"), "应收账款")
        self.assertEqual(items.normalize("*少数股东权益"), "少数股东权益")
        self.assertEqual(items.normalize("负债和所有者权益（或股东权益）总计"), "负债和所有者权益合计")

    def test_loose(self):
        self.assertEqual(items.loose("收回投资所收到的现金"), items.loose("收回投资收到的现金"))
        self.assertEqual(items.loose("支付给职工以及为职工支付的现金"), items.loose("支付给职工及为职工支付的现金"))
        self.assertEqual(items.loose("经营活动产生的现金流出小计"), items.loose("经营活动现金流出小计"))


class NumberTests(unittest.TestCase):
    def test_parse_and_format(self):
        self.assertEqual(tables.parse_number("1,234.50"), 1234.5)
        self.assertEqual(tables.parse_number("-64,136.41"), -64136.41)
        self.assertEqual(tables.parse_number("(12.00)"), -12.0)
        self.assertIsNone(tables.parse_number("合计"))
        self.assertEqual(tables.fmt_like(103030.2645, "90,817.93"), "103,030.26")
        self.assertEqual(tables.fmt_like(-3406.5555, "3,091.63"), "-3,406.56")
        self.assertEqual(tables.fmt_like(13.1449, "9.03"), "13.14")

    def test_minimal_change(self):
        s, e, b, a = plan_builder.minimal_change("营业收入为114,091.63万元", "营业收入为113,506.52万元")
        self.assertEqual((b, a), ("114,091.63", "113,506.52"))
        self.assertEqual(s, len("营业收入为"))


def _docx(paragraphs):
    """最小 DOCX：只含 document.xml 与必要的包结构。"""
    W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
    body = "".join(paragraphs)
    doc = f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="{W}"><w:body>{body}</w:body></w:document>'
    ct = ('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
          '<Default Extension="xml" ContentType="application/xml"/>'
          '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
    rels = ('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as z:
        z.writestr("[Content_Types].xml", ct)
        z.writestr("_rels/.rels", rels)
        z.writestr("word/document.xml", doc)
    return out.getvalue()


class DocxTests(unittest.TestCase):
    def test_bookmarks_moved_and_tab_prefix(self):
        raw = _docx([
            '<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="420"/></w:tabs></w:pPr><w:bookmarkStart w:id="1" w:name="_Toc1"/>'
            '<w:r><w:t>表5-1 截至2025年6月末</w:t></w:r><w:bookmarkEnd w:id="1"/></w:p>'])
        prepared = docx_model.prepare_source(raw)
        doc = docx_model.load(prepared)
        b = doc.blocks[0]
        self.assertTrue(b.simple)
        self.assertEqual(b.prefix, 1)   # writer.visible() 把 pPr 中的制表位计成一个 \t
        self.assertTrue(b.text.endswith("截至2025年6月末"))


@unittest.skipUnless(os.environ.get("BB_UPDATE_SAMPLE_DIR"), "需要真实样本（不入库）：设置 BB_UPDATE_SAMPLE_DIR")
class SampleRegression(unittest.TestCase):
    """任丘建投 2025 年 9 月末一期更新：已匹配表格的生成值必须与人工稿完全一致（wrong=0）。"""

    def test_renqiu_q3(self):
        import tempfile
        from bondbuddy_update import golden_eval, pipeline
        d = os.environ["BB_UPDATE_SAMPLE_DIR"]
        hist = next(os.path.join(d, f) for f in os.listdir(d) if f.startswith("2、任丘市建设投资集团"))
        xlsx = os.path.join(d, "0-报表-建投20250930-1.14.xlsx")
        gold = os.path.join(d, "任丘建设2025-09-golden.docx")
        with tempfile.TemporaryDirectory() as out:
            rep = pipeline.run(hist, [xlsx], "任丘市建设投资集团有限公司", out)
            self.assertEqual(rep["period_plan"]["mode"], "replace_latest")
            self.assertEqual(rep["rejected_edits"], [])
            g = golden_eval.compare(f"{out}/baseline-prepared.docx", f"{out}/清洁版.docx", gold)
            self.assertEqual(g["total"].get("wrong", 0), 0)
            self.assertGreaterEqual(g["total"].get("correct", 0), 240)


if __name__ == "__main__":
    unittest.main()
