"""local_redaction.py alone: the ruleset loader, the session map, mask and
restore. Pure functions over an inline ruleset (no runtime, no Hermes), so
these are plain unittest cases — `python -m unittest discover -s tests` and
`python -m pytest` both collect them.
"""
from __future__ import annotations

import copy
import json
import os
import stat
import sys
import tempfile
import unittest
import urllib.error
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from hermes_testkit import RULESET  # noqa: E402

from openguardrails_instrumentation_hermes import local_redaction as lr  # noqa: E402

OPENAI = "sk-proj-abcdefghijklmnopqrstuvwxyz0123"
ANTHROPIC = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz"
BEARER = "pk_cc7f7b3f73664638b8f30fe8ca598848"


def ruleset(tiers=None) -> lr.Ruleset:
    return lr.Ruleset(copy.deepcopy(RULESET), tiers)


class RulesetLoading(unittest.TestCase):
    def test_every_fixture_rule_compiles_and_passes_its_examples(self):
        rs = ruleset()
        self.assertEqual(rs.id, RULESET["id"])
        self.assertEqual([r.id for r in rs.rules],
                         ["entity_api_key", "entity_bearer_token", "entity_password_assignment"])
        self.assertEqual(rs.disabled, [])

    def test_a_rule_that_fails_its_own_examples_is_disabled_by_id(self):
        """Design D9: a dialect that drifts — here a pattern that compiles but
        does not mean what the examples say — is disabled, logged by id, and
        the rest of the ruleset runs. Never run wrong."""
        data = copy.deepcopy(RULESET)
        data["rules"][0]["patterns"][0]["source"] = r"sk-[a-z]{3}"   # too loose for nomatch
        with self.assertLogs("ogr-guard.redaction", level="WARNING") as log:
            rs = lr.Ruleset(data)
        self.assertEqual([i for i, _ in rs.disabled], ["entity_api_key"])
        self.assertIn("must not match but did", rs.disabled[0][1])
        self.assertTrue(any("entity_api_key disabled" in line for line in log.output))
        self.assertEqual([r.id for r in rs.rules],
                         ["entity_bearer_token", "entity_password_assignment"])

    def test_a_rule_that_will_not_compile_here_is_disabled(self):
        """The variable-width lookbehind CPython refuses — the exact construct
        the runtime's bearer rule used to carry."""
        data = copy.deepcopy(RULESET)
        data["rules"][1]["patterns"][0]["source"] = r"(?<=authorization:\s*bearer\s+)[A-Za-z0-9]{12,}"
        rs = lr.Ruleset(data)
        self.assertEqual([i for i, _ in rs.disabled], ["entity_bearer_token"])
        self.assertIn("does not compile", rs.disabled[0][1])

    def test_reject_value_filters_the_span_and_rescues_its_own_nomatch_example(self):
        """⚠️⚠️ A RULE IS ITS PATTERNS MINUS ITS FILTERS (OGR 1.4). The fixture's
        password rule carries a `nomatch` line the pattern alone CANNOT satisfy —
        it matches `${PASSWORD}` and a filter throws it away — so a reader that
        skipped `reject_value` would fail the example and disable the rule under
        D9. That is the field failure this test exists to keep closed: three of
        the reference runtime's rules were off on every host for five days."""
        rs = ruleset()
        rule = next(r for r in rs.rules if r.id == "entity_password_assignment")
        self.assertEqual(rs.disabled, [])
        self.assertTrue(rule.spans("password = hunter2hunter2"))
        self.assertEqual(rule.spans("password = ${PASSWORD}"), [])

        data = copy.deepcopy(RULESET)
        for raw in data["rules"]:
            raw.pop("reject_value", None)
        bare = lr.Ruleset(data)
        self.assertEqual([i for i, _ in bare.disabled], ["entity_password_assignment"])
        self.assertIn("must not match but did", bare.disabled[0][1])

    def test_every_predicate_kind_is_understood(self):
        """The vocabulary is CLOSED so that it can be ported; this is the port."""
        def spans(predicate, text, part=None):
            entry = {"predicate": predicate}
            if part:
                entry["part"] = part
            rule, err = lr.compile_rule({
                "id": "t", "category": "c", "severity": "high", "tier": "strong",
                "flags": "", "patterns": [{"id": "p", "source": r"V=(.+)"}], "group": 1,
                "reject_value": [entry], "examples": {"match": [], "nomatch": []},
            })
            self.assertIsNone(err or None, err)
            return len(rule.spans(text))

        self.assertEqual(spans({"kind": "placeholder"}, "V=${TOKEN}"), 0)
        self.assertEqual(spans({"kind": "placeholder", "anywhere": True}, "V=abc***def"), 0)
        self.assertEqual(spans({"kind": "placeholder"}, "V=abc***def"), 1)  # anchored by default
        self.assertEqual(spans({"kind": "secret_noun"}, "V=password"), 0)
        self.assertEqual(spans({"kind": "variable_reference"}, "V=config.api_key"), 0)
        self.assertEqual(spans({"kind": "names_secret"}, "V=DB_PASSWORD"), 0)
        self.assertEqual(spans({"kind": "structural"}, "V=get(name)"), 0)
        # ⚠️ A run of one character is 0 bits; shape and entropy are different questions.
        self.assertEqual(spans({"kind": "low_entropy", "min": 3}, "V=aaaaaaaaaa"), 0)
        self.assertEqual(spans({"kind": "low_entropy", "min": 3}, "V=Zx8Q1pLm9aQvR2tY"), 1)
        self.assertEqual(spans({"kind": "matches", "pattern": "^/"}, "V=/etc/passwd"), 0)
        after = {"of": "after", "sep": ":"}
        self.assertEqual(spans({"kind": "placeholder"}, "V=user:${PW}", after), 0)
        self.assertEqual(spans({"kind": "placeholder"}, "V=${USER}:realpassword", after), 1)

    def test_a_filter_this_engine_cannot_evaluate_disables_the_rule(self):
        """⚠️⚠️ Never read as "no filter": filters only ever make a rule match LESS,
        so skipping one masks far more than the runtime calls a credential — and the
        plugin would then restore a value into a tool's arguments under a token the
        runtime never minted."""
        for reject, expect in (
            ([{"predicate": {"kind": "time_travel"}}], "unknown predicate"),
            ([{"predicate": {"kind": "matches", "pattern": "(unbalanced"}}], "does not compile"),
            ([{"predicate": {"kind": "matches", "pattern": "^/", "flags": "g"}}], "outside the dialect"),
            ([{"predicate": {"kind": "low_entropy"}}], "numeric min"),
            ([{"part": {"of": "sideways", "sep": ":"}, "predicate": {"kind": "placeholder"}}], "unknown part"),
        ):
            data = copy.deepcopy(RULESET)
            data["rules"][0]["reject_value"] = reject
            rs = lr.Ruleset(data)
            self.assertEqual([i for i, _ in rs.disabled], ["entity_api_key"], reject)
            self.assertIn(expect, rs.disabled[0][1])
            # …and the rest of the ruleset still runs.
            self.assertEqual(len(rs.rules), 2)

    def test_tiers_select_which_rules_run(self):
        rs = ruleset({"strong"})
        self.assertEqual([r.id for r in rs.rules], ["entity_api_key", "entity_bearer_token"])
        self.assertEqual(rs.skipped_tiers, ["entity_password_assignment"])
        self.assertEqual(len(ruleset({"strong", "heuristic"})), 3)

    def test_flags_map_onto_re(self):
        rs = ruleset()
        text = "AUTHORIZATION: BEARER " + BEARER
        masked, minted = lr.mask(text, lr.SessionMap(), rs)
        self.assertEqual(masked, "AUTHORIZATION: BEARER OGRK00000001")
        self.assertEqual(minted, [{"token": "OGRK00000001",
                                   "rule": "entity_bearer_token/authorization_header"}])


class _FakeResponse:
    def __init__(self, body: bytes):
        self._body = body

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class RulesetStore(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.cache = os.path.join(self.dir, "sub", "rules.json")
        self.requests: list[dict] = []
        self.serve = {"ruleset": copy.deepcopy(RULESET)}

    def _urlopen(self, req, timeout=0):
        self.requests.append(dict(req.header_items()))
        inm = req.get_header("If-none-match", "")
        if inm.strip('"') == self.serve["ruleset"]["id"]:
            raise urllib.error.HTTPError(req.full_url, 304, "Not Modified", {}, None)
        return _FakeResponse(json.dumps(self.serve).encode())

    def _store(self):
        return lr.RulesetStore("https://rt.example", "key", cache_path=self.cache,
                               urlopen=self._urlopen)

    def test_fetch_adopts_and_caches_at_0600_then_304_keeps_it(self):
        store = self._store()
        self.assertTrue(store.fetch())
        self.assertEqual(store.ruleset_id, RULESET["id"])
        self.assertEqual(self.requests[0]["Authorization"], "Bearer key")
        self.assertNotIn("If-none-match", self.requests[0])
        mode = stat.S_IMODE(os.stat(self.cache).st_mode)
        self.assertEqual(mode, 0o600)
        self.assertEqual(json.load(open(self.cache))["ruleset"]["id"], RULESET["id"])
        # Second fetch: If-None-Match with the cached id, 304 → unchanged.
        self.assertFalse(store.fetch())
        self.assertEqual(self.requests[1]["If-none-match"], f'"{RULESET["id"]}"')
        self.assertEqual(store.ruleset_id, RULESET["id"])

    def test_cache_is_adopted_before_any_fetch(self):
        self._store().fetch()
        fresh = self._store()
        self.assertIsNone(fresh.current)
        self.assertTrue(fresh.load_cache())
        self.assertEqual(fresh.ruleset_id, RULESET["id"])
        self.assertEqual(self.requests[-1]["Authorization"], "Bearer key")  # only the one fetch

    def test_fetch_failure_keeps_the_cache_and_never_raises(self):
        store = self._store()
        store.fetch()

        def boom(req, timeout=0):
            raise urllib.error.URLError("dark")
        store._urlopen = boom
        self.assertFalse(store.fetch())
        self.assertEqual(store.ruleset_id, RULESET["id"])

    def test_the_cache_holds_rules_never_values(self):
        """The disk is what hermes keeps secrets off; the cache is rules only."""
        store = self._store()
        store.fetch()
        smap = lr.SessionMap()
        live = "sk-proj-LIVEVALUEnotanexample0123456789"   # not one of the examples
        masked, _ = lr.mask("token " + live, smap, store.current)
        self.assertEqual(masked, "token OGRK00000001")
        self.assertNotIn(live, open(self.cache).read())


class SessionMapBound(unittest.TestCase):
    def test_tokens_number_from_one_and_are_value_stable(self):
        smap = lr.SessionMap()
        self.assertEqual(smap.token_for("a"), ("OGRK00000001", True))
        self.assertEqual(smap.token_for("b"), ("OGRK00000002", True))
        self.assertEqual(smap.token_for("a"), ("OGRK00000001", False))

    def test_a_full_map_masks_with_the_non_restorable_placeholder(self):
        smap = lr.SessionMap(limit=3)
        for v in ("v1", "v2", "v3"):
            smap.token_for(v)
        with self.assertLogs("ogr-guard.redaction", level="WARNING"):
            self.assertEqual(smap.token_for("v4"), ("OGRKXXXXXXXX", False))
        # Known values keep working past the bound; the overflow is never mapped.
        self.assertEqual(smap.token_for("v2"), ("OGRK00000002", False))
        self.assertNotIn("OGRKXXXXXXXX", smap.by_token)
        _, unresolved = lr.restore("use OGRKXXXXXXXX", smap)
        self.assertEqual(unresolved, ["OGRKXXXXXXXX"])

    def test_the_default_bound_is_256(self):
        self.assertEqual(lr.MAX_VALUES, 256)
        self.assertEqual(lr.SessionMap().limit, 256)


class Mask(unittest.TestCase):
    def setUp(self):
        self.rs = ruleset()
        self.smap = lr.SessionMap()

    def test_round_trip(self):
        text = f'curl -H "Authorization: Bearer {BEARER}" https://api.example/v1'
        masked, minted = lr.mask(text, self.smap, self.rs)
        self.assertEqual(masked, 'curl -H "Authorization: Bearer OGRK00000001" https://api.example/v1')
        self.assertEqual(minted, [{"token": "OGRK00000001",
                                   "rule": "entity_bearer_token/authorization_header"}])
        restored, unresolved = lr.restore(masked, self.smap)
        self.assertEqual(restored, text)
        self.assertEqual(unresolved, [])

    def test_known_values_are_stable_across_steps_and_minted_once(self):
        m1, minted1 = lr.mask(f"key {OPENAI}", self.smap, self.rs)
        m2, minted2 = lr.mask(f"again {OPENAI} and {OPENAI}", self.smap, self.rs)
        self.assertEqual(m1, "key OGRK00000001")
        self.assertEqual(m2, "again OGRK00000001 and OGRK00000001")
        self.assertEqual(len(minted1), 1)
        self.assertEqual(minted2, [])          # history tokens are just text now
        # Known values are replaced even with NO ruleset (fail-open, cache lost).
        m3, minted3 = lr.mask(f"still {OPENAI}", self.smap, None)
        self.assertEqual((m3, minted3), ("still OGRK00000001", []))

    def test_overlap_longest_wins(self):
        """The anthropic form is also an openai-shaped `sk-…` match: one span,
        the longer, and the pattern that owns it is reported."""
        masked, minted = lr.mask(f"k={ANTHROPIC}", self.smap, self.rs)
        self.assertEqual(masked, "k=OGRK00000001")
        self.assertEqual(len(minted), 1)
        self.assertEqual(self.smap.by_token["OGRK00000001"], ANTHROPIC)
        # Equal length ⇒ served (array) order; here both patterns sit in one
        # rule and the first-listed wins, which is the openai arm.
        self.assertEqual(minted[0]["rule"], "entity_api_key/openai")

    def test_no_rematch_inside_an_existing_token(self):
        text = "Authorization: Bearer OGRK00000001 and ${OGR_PHONE_2} then sk-${TOKEN}"
        masked, minted = lr.mask(text, self.smap, self.rs)
        self.assertEqual(masked, text)
        self.assertEqual(minted, [])
        # …and a known value inside a token is not re-masked either.
        self.smap.token_for("SECRET")
        masked, _ = lr.mask("OGRK00000001", self.smap, self.rs)
        self.assertEqual(masked, "OGRK00000001")

    def test_a_zero_width_split_value_is_still_masked_whole(self):
        split = OPENAI[:10] + "\u200b" + OPENAI[10:20] + "\u200d" + OPENAI[20:]
        masked, minted = lr.mask(f"key={split}!", self.smap, self.rs)
        # The splice removes the split characters WITH the value…
        self.assertEqual(masked, "key=OGRK00000001!")
        # …and the value restored is the clean one.
        self.assertEqual(self.smap.by_token["OGRK00000001"], OPENAI)
        # Text outside the span keeps its own control characters.
        masked, _ = lr.mask(f"a\u200bb {OPENAI}", self.smap, self.rs)
        self.assertEqual(masked, "a\u200bb OGRK00000001")

    def test_heuristic_tier_runs_by_default_and_only_the_value_is_the_span(self):
        masked, minted = lr.mask("password = hunter2hunter2", self.smap, self.rs)
        self.assertEqual(masked, "password = OGRK00000001")
        self.assertEqual(minted[0]["rule"], "entity_password_assignment/assignment")

    def test_request_walk_keeps_structure(self):
        req = {
            "model": "m",
            "messages": [
                {"role": "system", "content": f"The key is {OPENAI}."},
                {"role": "user", "content": [
                    {"type": "text", "text": f"use {OPENAI} please"},
                    {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}},
                ]},
                {"role": "tool", "tool_call_id": "c1",
                 "content": f"Authorization: Bearer {BEARER}\nok"},
            ],
            "tools": [{"type": "function",
                       "function": {"name": "f", "description": f"example {ANTHROPIC}"}}],
            "temperature": 0.2,
            "extra_headers": {"Authorization": f"Bearer {BEARER}"},
        }
        before = copy.deepcopy(req)
        masked, minted = lr.mask_request(req, self.smap, self.rs)
        self.assertEqual(req, before)                       # the caller's dict is untouched
        self.assertEqual(masked["model"], "m")
        self.assertEqual(masked["temperature"], 0.2)
        self.assertEqual(len(masked["messages"]), 3)
        self.assertEqual(masked["messages"][0]["content"], "The key is OGRK00000001.")
        blocks = masked["messages"][1]["content"]
        self.assertEqual([b["type"] for b in blocks], ["text", "image_url"])
        self.assertEqual(blocks[0]["text"], "use OGRK00000001 please")
        self.assertEqual(blocks[1]["image_url"]["url"], "data:image/png;base64,AAAA")
        self.assertEqual(masked["messages"][2]["content"], "Authorization: Bearer OGRK00000002\nok")
        self.assertEqual(masked["messages"][2]["tool_call_id"], "c1")
        self.assertEqual(masked["tools"][0]["function"]["description"], "example OGRK00000003")
        # Transport carries the DEPLOYMENT's own credential to the provider:
        # masking it would break the call with nothing naming why.
        self.assertEqual(masked["extra_headers"]["Authorization"], f"Bearer {BEARER}")
        self.assertEqual([m["token"] for m in minted],
                         ["OGRK00000001", "OGRK00000002", "OGRK00000003"])

    def test_responses_input_and_anthropic_system_are_walked_too(self):
        req = {"input": [{"role": "user", "content": [{"type": "input_text", "text": OPENAI}]}],
               "system": f"Bearer: {ANTHROPIC}"}
        masked, _ = lr.mask_request(req, self.smap, self.rs)
        self.assertEqual(masked["input"][0]["content"][0]["text"], "OGRK00000001")
        self.assertEqual(masked["system"], "Bearer: OGRK00000002")

    def test_masked_report_never_carries_a_value(self):
        _, minted = lr.mask(f"{OPENAI} {BEARER}", self.smap, self.rs)
        for m in minted:
            self.assertEqual(set(m), {"token", "rule"})
            self.assertRegex(m["token"], r"^OGRK\d{8}$")


class Restore(unittest.TestCase):
    def setUp(self):
        self.smap = lr.SessionMap()
        self.smap.token_for(OPENAI)       # OGRK00000001
        self.smap.token_for(BEARER)       # OGRK00000002

    def test_markdown_escaped_token_restores(self):
        # The `${OGR_…}` shape is no longer minted but stays restorable: an older
        # plugin's tokens are ADOPTED into the map, and their escapes are absorbed.
        legacy = lr.SessionMap()
        self.assertTrue(legacy.adopt("${OGR_SECRET_1}", OPENAI))
        self.assertTrue(legacy.adopt("${OGR_SECRET_2}", BEARER))
        text = r"curl -H 'Authorization: Bearer ${OGR\_SECRET\_2}' \$\{OGR\_SECRET\_1\}"
        restored, unresolved = lr.restore(text, legacy)
        self.assertEqual(restored, f"curl -H 'Authorization: Bearer {BEARER}' {OPENAI}")
        self.assertEqual(unresolved, [])

    def test_a_backslash_before_a_non_escapable_stays_literal(self):
        restored, _ = lr.restore(r"C:\name OGRK00000001", self.smap)
        self.assertEqual(restored, rf"C:\name {OPENAI}")

    def test_never_fuzzy_never_prefix(self):
        # A longer number that merely STARTS with a known token's text.
        restored, unresolved = lr.restore("OGRK00000010", self.smap)
        self.assertEqual(restored, "OGRK00000010")
        self.assertEqual(unresolved, ["OGRK00000010"])
        # A typo'd token is not "close enough".
        restored, unresolved = lr.restore("${OGR_SECRET_1", self.smap)
        self.assertEqual(restored, "${OGR_SECRET_1")
        self.assertEqual(unresolved, [])

    def test_unresolved_tokens_are_reported_in_order_without_duplicates(self):
        text = "OGRK00000007 OGRK00000001 ${OGR\\_SECRET\\_9} ${OGR_PHONE_3} OGRK00000007"
        restored, unresolved = lr.restore(text, self.smap)
        self.assertIn(OPENAI, restored)
        self.assertEqual(unresolved, ["OGRK00000007", "${OGR_SECRET_9}", "${OGR_PHONE_3}"])

    def test_restore_args_walks_every_string_leaf(self):
        args = {"command": "curl -H 'Authorization: Bearer OGRK00000002'",
                "env": {"OPENAI_API_KEY": "OGRK00000001"},
                "paths": ["OGRK00000001", 3, None],
                "timeout": 30}
        before = copy.deepcopy(args)
        restored, unresolved = lr.restore_args(args, self.smap)
        self.assertEqual(args, before)
        self.assertEqual(unresolved, [])
        self.assertEqual(restored["command"], f"curl -H 'Authorization: Bearer {BEARER}'")
        self.assertEqual(restored["env"]["OPENAI_API_KEY"], OPENAI)
        self.assertEqual(restored["paths"], [OPENAI, 3, None])
        self.assertEqual(restored["timeout"], 30)

    def test_an_unresolved_token_anywhere_in_the_args_is_reported(self):
        _, unresolved = lr.restore_args({"a": {"b": ["fine", "OGRK00000042"]}}, self.smap)
        self.assertEqual(unresolved, ["OGRK00000042"])
        notice = lr.unresolved_notice(unresolved)
        self.assertIn("OGRK00000042 could not be restored", notice)
        self.assertIn("ask the user to provide it again", notice)


if __name__ == "__main__":
    unittest.main()
