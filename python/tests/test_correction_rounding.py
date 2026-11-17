import unittest
from bondbuddy_file_authoring.correction_rounding import rounded_sum_limitation


class CorrectionRoundingTests(unittest.TestCase):
    def test_rounded_operands_cannot_disprove_original_total(self):
        evidence = '分项为1.13万元、2.24万元、3.34万元、4.45万元，合计11.16万元。'
        self.assertTrue(rounded_sum_limitation('费用11.14万元。', '费用11.16万元。', evidence))

    def test_smaller_and_negative_totals_keep_rounding_uncertainty(self):
        for original, replacement, evidence in [
            ('合计3.57万元', '合计3.56万元', '分项1.23万元、2.33万元，合计3.56万元'),
            ('合计-11.14万元', '合计-11.16万元', '分项-1.13万元、-2.24万元、-3.34万元、-4.45万元'),
            ('合计3.30万元', '合计3.34万元', '分项1.1万元、2.24万元'),
            ('合计3,003.57万元', '合计3,003.56万元', '分项1,001.23万元、2,002.33万元'),
            ('比例3.57%', '比例3.56%', '分项1.23%、2.33%'),
        ]:
            with self.subTest(original=original):
                self.assertTrue(rounded_sum_limitation(original, replacement, evidence))

    def test_error_outside_accumulated_precision_is_not_hidden(self):
        self.assertFalse(rounded_sum_limitation('费用11.00万元', '费用11.16万元',
                                              '分项1.13万元、2.24万元、3.34万元、4.45万元'))

    def test_unrounded_operands_can_establish_a_small_actual_error(self):
        self.assertFalse(rounded_sum_limitation('费用11.16万元', '费用11.14万元',
                                              '分项原始金额1.1251万元、2.2351万元、3.3351万元、4.4451万元'))

    def test_explicit_audit_comparison_is_not_a_rounded_sum(self):
        self.assertFalse(rounded_sum_limitation('费用11.15万元', '费用11.16万元',
                                              '审计原表费用合计11.16万元；原文引用错误'))

    def test_units_noop_and_non_aggregate_edits_are_not_reclassified(self):
        for before, after, evidence in [
            ('合计3.57万元', '合计3.56万元', '分项1.23元、2.33元'),
            ('合计3.57万元', '合计3.56亿元', '分项1.23亿元、2.33亿元'),
            ('合计3.56万元', '合计3.56万元', '分项1.23万元、2.33万元'),
            ('Bond，2026。', 'Bond, 2026.', '原文标点错误'),
        ]:
            with self.subTest(before=before):
                self.assertFalse(rounded_sum_limitation(before, after, evidence))

    def test_malformed_number_does_not_create_spurious_operand(self):
        self.assertFalse(rounded_sum_limitation('合计3.57万元', '合计3.56万元',
                                              '分项1,23万元、2.33万元'))

    def test_many_operands_and_extreme_numbers_require_manual_review(self):
        self.assertTrue(rounded_sum_limitation('合计3.57万元', '合计3.56万元', '分项'+ '1.00万元、' * 129))
        self.assertTrue(rounded_sum_limitation('合计3.57万元', '合计3.56万元', '分项'+'9'*65+'万元'))


if __name__ == '__main__':
    unittest.main()
