"""Tests for claims_check. Each "catches" case is a mistake that should be flagged;
each "leaves alone" case is ordinary writing that must NOT be flagged (false alarms make a checker useless)."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'checks'))
from claims_check import check_text  # noqa: E402


def fails(text, year=2026):
    return [f for f in check_text(text, year) if f.level == 'FAIL']


def warns(text, year=2026):
    return [f for f in check_text(text, year) if f.level == 'WARN']


class Dates(unittest.TestCase):
    def test_catches_wrong_weekday(self):
        self.assertEqual(len(fails('Posting goes out Thu 10/2 at 6pm.')), 1)  # Oct 2 2026 is a Friday
        self.assertIn('Friday', fails('Posting goes out Thu 10/2 at 6pm.')[0].msg)
        self.assertEqual(len(fails('Meeting on Tuesday, September 28.')), 1)
        self.assertEqual(len(fails('Sat 14 Jun 2026')), 1)  # a Sunday
        self.assertEqual(len(fails('2026-09-28 (Sun)')), 1)
        self.assertEqual(len(fails('Sep 28 (Tue)')), 1)

    def test_catches_impossible_date(self):
        self.assertEqual(len(fails('Due Mon 2/30')), 1)

    def test_leaves_right_dates_alone(self):
        text = ('Mon 9/28 6pm brand spot; Thu 10/1 6pm the Tale. Friday, October 2 numbers. '
                'Sun 14 Jun 2026. 2026-09-28 (Mon). Sept 27 (Sun). Wednesday Sep 30th, 2026.')
        self.assertEqual(fails(text), [])

    def test_explicit_year_wins(self):
        self.assertEqual(fails('Mon 9/28/2020'), [])  # Sep 28 2020 was a Monday
        self.assertEqual(len(fails('Mon 9/28/2021')), 1)


class Arithmetic(unittest.TestCase):
    def test_catches_wrong_math(self):
        self.assertEqual(len(fails('That is 12 x 40 = 460 posts.')), 1)
        self.assertEqual(len(fails('$1,200 + $300 = $1,400')), 1)
        self.assertEqual(len(fails('5K × 3 = 12K')), 1)
        self.assertEqual(len(fails('100 / 8 = 14')), 1)

    def test_allows_rounding_to_shown_precision(self):
        self.assertEqual(fails('100 / 8 = 12.5 and 10 / 3 = 3.33 and 2 x 1.1 = 2.2'), [])
        self.assertEqual(fails('100 / 8 = 13'), [])  # 12.5 fairly rounds to 13
        self.assertEqual(fails('20 posts × 4 weeks = 80'), [])

    def test_ignores_dates_and_ranges(self):
        self.assertEqual(fails('Aug 1-2 = weekend, 9/28 = Monday'), [])


class Ratios(unittest.TestCase):
    def test_catches_bad_percent(self):
        self.assertEqual(len(fails('3 of 12 (30%) posts were real.')), 1)
        self.assertEqual(len(fails('Only 8 out of 264 posts, about 12%, are real')), 1)

    def test_leaves_good_percent_alone(self):
        self.assertEqual(fails('3 of 12 (25%) and 8 of 264 (3%) and 1 of 3 (33.3%)'), [])


class Changes(unittest.TestCase):
    def test_catches_bad_change(self):
        self.assertEqual(len(fails('Followers went from 40 to 50, up 20%.')), 1)
        self.assertEqual(len(fails('Visits dropped 10% from 200 to 150')), 1)

    def test_leaves_good_change_alone(self):
        self.assertEqual(fails('Followers went from 40 to 50, up 25%. Visits dropped 25% from 200 to 150.'), [])
        self.assertEqual(fails('Signups went from 70 to 85, up about 21%.'), [])  # 21.4, rounded

    def test_skips_percentage_points(self):
        self.assertEqual(fails('Click rate went from 2% to 3%, up 1%'), [])


class Money(unittest.TestCase):
    def test_flags_three_decimals(self):
        self.assertEqual(len(warns('Cash out $14,543.111 now')), 1)

    def test_normal_money_ok(self):
        self.assertEqual([w for w in warns('Paid $14,543.11 total') if 'decimal' in w.msg], [])


class Tables(unittest.TestCase):
    def test_catches_bad_total(self):
        t = '| Corner | Posts |\n|---|---|\n| Outdoors | 3 |\n| Garage | 4 |\n| **Total** | **8** |\n'
        f = fails(t)
        self.assertEqual(len(f), 1)
        self.assertIn('add up to 7', f[0].msg)

    def test_good_total(self):
        t = '| Corner | Posts | Cost |\n|---|---|---|\n| A | 3 | $1,000 |\n| B | 4 | $250.50 |\n| Total | 7 | $1,250.50 |\n'
        self.assertEqual(fails(t), [])


class Sources(unittest.TestCase):
    def test_flags_unsourced_stats(self):
        self.assertEqual(len(warns('Lemmy has about 48.6K monthly active users.')), 1)

    def test_sourced_stats_ok(self):
        self.assertEqual(warns('Lemmy has about 48.6K monthly active users ([FediDB](https://fedidb.org)).'), [])
        self.assertEqual(warns('Lemmy has about 48.6K monthly active users [1].'), [])

    def test_code_blocks_ignored(self):
        self.assertEqual(fails('```\nMon 10/2\n12 x 40 = 460\n```'), [])


if __name__ == '__main__':
    unittest.main()
