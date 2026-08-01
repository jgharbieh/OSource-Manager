import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import {
  canonicalizeGitUrl,
  canonicalKeyForGitUrl,
  canonicalKeyForNpm,
  canonicalKeyForSkill,
  canonicalKeyForLocal,
  aliasesForGitUrl,
  nameFromCanonicalKey,
  repoWebUrl,
} from '../dist/core/canonical.js';

const KEY = 'github.com/owner/repo';

test('all spellings of the same GitHub repo canonicalize identically', () => {
  const variants = [
    'https://github.com/owner/repo',
    'https://github.com/owner/repo.git',
    'https://github.com/owner/repo/',
    'https://www.github.com/owner/repo.git',
    'http://github.com/owner/repo',
    'git@github.com:owner/repo.git',
    'git@github.com:owner/repo',
    'ssh://git@github.com/owner/repo.git',
    'git://github.com/owner/repo.git',
    '  https://github.com/owner/repo.git  ',
  ];
  for (const v of variants) {
    assert.equal(canonicalizeGitUrl(v), KEY, v);
    assert.equal(canonicalKeyForGitUrl(v), KEY, v);
  }
});

test('trailing slashes and .git are stripped in any order', () => {
  assert.equal(canonicalizeGitUrl('https://github.com/owner/repo.git/'), KEY);
  assert.equal(canonicalizeGitUrl('https://github.com/owner/repo///'), KEY);
});

test('gitlab SSH and HTTPS forms collapse', () => {
  const key = 'gitlab.com/group/proj';
  assert.equal(canonicalizeGitUrl('git@gitlab.com:group/proj.git'), key);
  assert.equal(canonicalizeGitUrl('https://gitlab.com/group/proj'), key);
});

test('bitbucket and self-hosted hosts', () => {
  assert.equal(canonicalizeGitUrl('git@bitbucket.org:team/lib.git'), 'bitbucket.org/team/lib');
  assert.equal(
    canonicalizeGitUrl('ssh://git@git.example.com:2222/team/lib.git'),
    'git.example.com/team/lib',
  );
  assert.equal(canonicalizeGitUrl('https://git.example.com/team/lib'), 'git.example.com/team/lib');
});

test('host is lowercased', () => {
  assert.equal(canonicalizeGitUrl('https://GitHub.com/Owner/Repo'), 'github.com/Owner/Repo');
});

test('garbage returns null', () => {
  assert.equal(canonicalizeGitUrl(''), null);
  assert.equal(canonicalizeGitUrl('   '), null);
  assert.equal(canonicalizeGitUrl('not a url at all'), null);
  assert.equal(canonicalizeGitUrl('https://github.com/'), null);
  assert.equal(canonicalizeGitUrl('https://github.com/justone'), null);
  assert.equal(canonicalizeGitUrl('https://github.com/a/b/c'), null);
  assert.equal(canonicalizeGitUrl('ssh://git@github.com'), null);
});

test('key builders', () => {
  assert.equal(canonicalKeyForNpm('typescript'), 'npm:typescript');
  assert.equal(canonicalKeyForNpm('@scope/pkg'), 'npm:@scope/pkg');
  assert.equal(canonicalKeyForSkill('commit'), 'skill:commit');
});

test('canonicalKeyForLocal: 12 hex chars, path-style insensitive', () => {
  const fwd = canonicalKeyForLocal(resolve('C:/Tools/Foo'));
  const back = canonicalKeyForLocal(join('C:\\Tools', 'Foo'));
  const lower = canonicalKeyForLocal('c:/tools/foo');
  assert.match(fwd, /^local:[0-9a-f]{12}$/);
  assert.equal(fwd, back, 'forward vs backslash');
  assert.equal(fwd, lower, 'case-insensitive');
  assert.notEqual(canonicalKeyForLocal('c:/tools/bar'), fwd);
});

test('aliasesForGitUrl covers the spellings and is deduped', () => {
  const aliases = aliasesForGitUrl('git@github.com:owner/repo.git');
  assert.equal(new Set(aliases).size, aliases.length, 'deduped');
  for (const a of aliases) {
    assert.equal(canonicalizeGitUrl(a), KEY, `alias ${a} re-canonicalizes`);
  }
  assert.ok(aliases.includes('https://github.com/owner/repo'));
  assert.ok(aliases.includes('git@github.com:owner/repo.git'));
  assert.ok(aliases.includes('https://www.github.com/owner/repo'));
  assert.deepEqual(aliasesForGitUrl('garbage url !!'), []);
});

test('nameFromCanonicalKey', () => {
  assert.equal(nameFromCanonicalKey(KEY), 'repo');
  assert.equal(nameFromCanonicalKey('npm:@scope/pkg'), '@scope/pkg');
  assert.equal(nameFromCanonicalKey('skill:commit'), 'commit');
  assert.equal(nameFromCanonicalKey('local:0123456789ab'), '0123456789ab');
});

test('repoWebUrl', () => {
  assert.equal(repoWebUrl(KEY), 'https://github.com/owner/repo');
  assert.equal(repoWebUrl('gitlab.com/group/proj'), 'https://gitlab.com/group/proj');
});
