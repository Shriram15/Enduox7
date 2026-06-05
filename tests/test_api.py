import unittest
from app import app

class RaceAPITest(unittest.TestCase):
    def setUp(self):
        self.client = app.test_client()
        r = self.client.post('/api/race/reset')
        self.assertEqual(r.status_code, 200)
        resp = self.client.get('/api/race/status')
        d = resp.get_json()
        # ensure clean state
        self.assertEqual(d['state'], 'setup')
        self.assertEqual(len(d['teams']), 0)

    def add_team(self, bib, category):
        r = self.client.post('/api/teams', json={'bib': bib, 'category': category})
        self.assertEqual(r.status_code, 200)
        d = r.get_json()
        self.assertTrue(d.get('success', False))

    def start_hour(self):
        r = self.client.post('/api/race/start_hour')
        self.assertEqual(r.status_code, 200)
        d = r.get_json()
        self.assertTrue(d.get('success', False))

    def test_add_and_status(self):
        self.add_team(1, 'duo')
        self.add_team(2, 'solo_m')
        self.add_team(3, 'solo_f')
        r = self.client.get('/api/race/status')
        d = r.get_json()
        self.assertIn('teams', d)
        self.assertEqual(len(d['teams']), 3)

    def test_start_and_single_and_infer_solo(self):
        self.add_team(10, 'duo')
        self.add_team(20, 'solo_m')
        self.start_hour()
        r = self.client.post('/api/lap', json={'bib': 10, 'runner': 'M'})
        d = r.get_json()
        self.assertTrue(d.get('success', False))

        r2 = self.client.post('/api/lap', json={'bib': 20})
        d2 = r2.get_json()
        self.assertTrue(d2.get('success', False))
        self.assertEqual(d2.get('runner'), 'M')

    def test_batch_lap_with_runner(self):
        self.add_team(30, 'duo')
        self.add_team(31, 'duo')
        self.start_hour()
        r = self.client.post('/api/lap', json={'bibs': [30, 31], 'runner': 'F'})
        self.assertEqual(r.status_code, 200)
        d = r.get_json()
        self.assertTrue(d.get('success', False))
        results = d.get('results', [])
        self.assertEqual(len(results), 2)
        for rr in results:
            self.assertTrue(rr.get('success', False))
            self.assertEqual(rr.get('runner'), 'F')

    def test_mark_dnf(self):
        self.add_team(40, 'duo')
        # need at least 2 teams to start hour
        self.add_team(41, 'duo')
        self.start_hour()
        r = self.client.post('/api/dnf', json={'bib': 40, 'runner': 'BOTH'})
        self.assertEqual(r.status_code, 200)
        d = r.get_json()
        self.assertTrue(d.get('success', False))

        r2 = self.client.post('/api/lap', json={'bib': 40, 'runner': 'M'})
        d2 = r2.get_json()
        self.assertIn('error', d2)

    def test_leaderboard_categories(self):
        self.client.post('/api/race/reset')
        self.add_team(50, 'duo')
        self.add_team(51, 'solo_m')
        self.add_team(52, 'solo_f')
        self.start_hour()
        self.client.post('/api/lap', json={'bib': 50, 'runner': 'M'})
        self.client.post('/api/lap', json={'bib': 51})
        self.client.post('/api/lap', json={'bib': 52})
        r = self.client.get('/api/race/status')
        d = r.get_json()
        lb = d.get('leaderboard', [])
        cats = set(e['category'] for e in lb)
        self.assertTrue({'Duo', 'Solo M', 'Solo F'}.issubset(cats))

    def test_reset(self):
        self.client.post('/api/race/reset')
        r = self.client.get('/api/race/status')
        d = r.get_json()
        self.assertEqual(d['state'], 'setup')
        self.assertEqual(len(d['teams']), 0)

if __name__ == '__main__':
    unittest.main()
