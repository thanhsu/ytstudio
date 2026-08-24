import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSourceSearchQueries,
  expandSourceAliases,
  splitEpisode,
  stripDiacritics,
} from "../src/web/search-queries.js";

test("a query with no episode marker is left alone", () => {
  assert.deepEqual(splitEpisode("mục thần ký"), { title: "mục thần ký", episode: "" });
});

test("an episode marker is split off in the forms people actually type", () => {
  assert.deepEqual(splitEpisode("mục thần ký tập 12"), { title: "mục thần ký", episode: "12" });
  assert.deepEqual(splitEpisode("Đấu Phá Thương Khung tap 05"), { title: "Đấu Phá Thương Khung", episode: "5" });
  assert.deepEqual(splitEpisode("牧神记 第7集"), { title: "牧神记", episode: "7" });
  assert.deepEqual(splitEpisode("some show episode 3"), { title: "some show", episode: "3" });
  assert.deepEqual(splitEpisode("another ep 41"), { title: "another", episode: "41" });
});

test("diacritics are stripped without mangling the letters underneath", () => {
  assert.equal(stripDiacritics("mục thần ký"), "muc than ky");
  assert.equal(stripDiacritics("Đấu Phá Thương Khung"), "Dau Pha Thuong Khung");
  assert.equal(stripDiacritics("牧神记"), "牧神记");
});

test("episode expansion uses the title the operator typed", () => {
  const expanded = expandSourceAliases("Đấu Phá Thương Khung tập 5");

  assert.ok(expanded.some((entry) => entry.includes("Đấu Phá Thương Khung")));
  assert.ok(expanded.some((entry) => entry.includes("第5集")));
});

test("expansion never injects a show the operator did not ask for", () => {
  // The first version hardcoded one title and appended it to every episode
  // query, so searching for any other show quietly returned that one instead.
  for (const query of ["Đấu Phá Thương Khung tập 5", "one piece episode 1090", "some show tap 2"]) {
    for (const entry of expandSourceAliases(query)) {
      assert.ok(!entry.includes("牧神记"), `${query} expanded to ${entry}`);
    }
  }
});

test("a Vietnamese query also gets a plain-ascii variant, which Chinese sites match better", () => {
  const expanded = expandSourceAliases("mục thần ký");
  assert.ok(expanded.includes("muc than ky"));
});

test("a query with no diacritics gains no duplicate ascii variant", () => {
  const expanded = expandSourceAliases("one piece");
  assert.deepEqual(expanded.filter((entry) => entry === "one piece"), []);
});

test("operator aliases are used when supplied, and only for a matching query", () => {
  const aliases = [{ match: ["mục thần ký", "muc than ky"], queries: ["牧神记", "Tales of Herding Gods"] }];

  assert.deepEqual(expandSourceAliases("mục thần ký tập 3", aliases).slice(0, 2), ["牧神记", "Tales of Herding Gods"]);
  assert.ok(!expandSourceAliases("one piece", aliases).includes("牧神记"));
});

test("the query list keeps the operator query first and drops duplicates", () => {
  const queries = buildSourceSearchQueries({ query: "mục thần ký", platform: "bilibili" });

  assert.equal(queries[0], "mục thần ký");
  assert.equal(new Set(queries).size, queries.length);
  assert.ok(queries.length <= 6);
});

test("expansion only applies where it helps, and can be switched off", () => {
  assert.deepEqual(buildSourceSearchQueries({ query: "mục thần ký", platform: "youtube" }), ["mục thần ký"]);
  assert.deepEqual(
    buildSourceSearchQueries({ query: "mục thần ký", platform: "bilibili", expandBilibiliQuery: false }),
    ["mục thần ký"],
  );
});

test("an edited query list wins over anything generated", () => {
  const queries = buildSourceSearchQueries({
    query: "mục thần ký",
    platform: "bilibili",
    expandedQueries: "牧神记\n牧神记 解说",
  });

  assert.deepEqual(queries, ["牧神记", "牧神记 解说"]);
});

test("an empty query produces no searches rather than an empty one", () => {
  assert.deepEqual(buildSourceSearchQueries({ query: "   ", platform: "bilibili" }), []);
  assert.deepEqual(buildSourceSearchQueries({ platform: "bilibili" }), []);
});
