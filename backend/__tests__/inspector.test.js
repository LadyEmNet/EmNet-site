import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';

const modulePromise = import('../index.js');

test('buildInspectorProfile resolves nested Lands Inspector values', async () => {
  const { extractInspectorValue, buildInspectorProfile } = await modulePromise;

  const payload = {
    points: null,
    statusMessage: 'Active participant',
    profile: {
      relative_id: '12',
      referrer_id: '34',
    },
    stats: {
      overview: {
        pointsBalance: {
          value: '78000',
          decimals: 1,
        },
        redeemedPoints: {
          value: '1200',
        },
        weeklyDraws: {
          eligible: true,
          entries: 5,
          weeks: ['Week 1', 'Week 2'],
          availablePrizeAssetIds: ['3215542831'],
          claimedPrizeAssetIds: [],
        },
      },
    },
    completions: {
      completedQuests: ['Quest A'],
      completedChallenges: ['Challenge A', 'Challenge B'],
      completableChallenges: ['Challenge C'],
    },
    referrals: {
      list: ['ADDR1', 'ADDR2'],
      referralCount: '2',
    },
  };

  const resolvedPoints = extractInspectorValue(payload, ['points', 'pointsBalance']);
  assert.equal(resolvedPoints.value, '78000');

  const profile = buildInspectorProfile(
    'EMNETCRVN2B4LYV4BDQ5JFYBJVAK663G2AOEENUV2WZK5U6FS3LNEIWTCU',
    payload,
  );

  assert.equal(profile.points, 7800);
  assert.equal(profile.pointsRaw, 78000);
  assert.equal(profile.redeemedPoints, 1200);
  assert.equal(profile.relativeId, 12);
  assert.equal(profile.referrerId, 34);
  assert.equal(profile.status, 'ok');
  assert.equal(profile.statusMessage, 'Active participant');
  assert(profile.hasParticipation);
  assert.equal(profile.weeklyDraws.entries, 5);
  assert(profile.weeklyDraws.eligible);
  assert.deepEqual(profile.weeklyDraws.weeks, ['Week 1', 'Week 2']);
  assert.deepEqual(profile.availableDrawPrizeAssetIds, ['3215542831']);
  assert.deepEqual(profile.claimedDrawPrizeAssetIds, []);
  assert.deepEqual(profile.completedQuests, ['Quest A']);
  assert.deepEqual(profile.completedChallenges, ['Challenge A', 'Challenge B']);
  assert.deepEqual(profile.completableChallenges, ['Challenge C']);
  assert.deepEqual(profile.referrals, ['ADDR1', 'ADDR2']);
  assert.equal(profile.referralsCount, 2);
});
