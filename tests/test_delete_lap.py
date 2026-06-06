import unittest
from app import app


class DeleteLapTest(unittest.TestCase):
    def setUp(self):
        self.client = app.test_client()
        self.client.post('/api/race/reset')
        # register two bibs and start
        self.client.post('/api/teams', json={'bib': 1, 'category': 'duo'})
        self.client.post('/api/teams', json={'bib': 2, 'category': 'duo'})
        self.client.post('/api/race/start_hour')

    def test_delete_last_lap(self):
        # record two laps for bib 1
        self.client.post('/api/lap', json={'bib': 1, 'runner': 'M'})
        self.client.post('/api/lap', json={'bib': 1, 'runner': 'F'})

        r = self.client.delete('/api/lap', json={'bib': 1})
        self.assertEqual(r.status_code, 200)
        d = r.get_json()
        self.assertTrue(d.get('success'))
        # now status should show 1 total lap for bib 1
        s = self.client.get('/api/race/status').get_json()
        bib_info = s['teams'].get('1')
        self.assertEqual(bib_info['total_laps'], 1)


if __name__ == '__main__':
    unittest.main()
