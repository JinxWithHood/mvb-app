from pyhafas import HafasClient
from pyhafas.profile import NASAProfile
import datetime

client = HafasClient(NASAProfile())
try:
    start_locs = client.locations("Neustdter Platz")
    dest_locs = client.locations("Allee-Center")
    if start_locs and dest_locs:
        journeys = client.journeys(
            origin=start_locs[0].id,
            destination=dest_locs[0].id,
            date=datetime.datetime.now(),
            max_journeys=1
        )
        if journeys:
            leg = journeys[0].legs[0]
            print("Leg Properties:")
            for field in dir(leg):
                if not field.startswith('_'):
                    print(f"  {field}: {repr(getattr(leg, field))}")
except Exception as e:
    print("Error:", e)
