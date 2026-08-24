"""THE ADAPTERS — one per dialect a scanner speaks.

⚠️⚠️ **Third parties will not implement our JSON, and this list is the real
integration surface.** The customers who most need artifact scanning are the ones
whose traffic may not leave the building, and they usually already own a scanner
they are contractually required to use. An adapter is how that scanner is admitted.

⚠️ **An adapter maps a vendor's answer onto the three-state verdict, and one that
cannot express `suspicious` MUST SAY SO rather than collapsing it to `clean`.**
ICAP in particular is largely binary (`204 No Modification` / `200` with a block
page): its "not clean" is reported as `malicious`, and its silence is `clean`,
with no middle. Pretending otherwise would put a confidence in the record that the
protocol underneath never had.
"""

from .base import Adapter, AdapterError
from .clamav import ClamAVAdapter
from .http_json import HttpJsonAdapter
from .icap import IcapAdapter

#: `provider` name → adapter class. The runtime's `provider_hint` names one of
#: these; a PEP MAY ignore the hint, and MUST NOT treat it as an address.
ADAPTERS = {
    "malware0": HttpJsonAdapter,
    "http_generic": HttpJsonAdapter,
    "clamav": ClamAVAdapter,
    "icap": IcapAdapter,
}

__all__ = ["Adapter", "AdapterError", "ADAPTERS", "HttpJsonAdapter", "ClamAVAdapter", "IcapAdapter"]
