import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';

const modulePromise = import(new URL('../index.js', import.meta.url));

test('buildSdkProfile formats Algoland SDK user details', async () => {
  const { buildSdkProfile } = await modulePromise;

  const algolandUser = {
    address: 'EMNETCRVN2B4LYV4BDQ5JFYBJVAK663G2AOEENUV2WZK5U6FS3LNEIWTCU',
    relativeId: 12,
    referrerId: 34,
    numReferrals: 2,
    referrals: [55, 56],
    points: 78,
    displayPoints: 7800,
    redeemedPoints: 12,
    displayRedeemedPoints: 1200,
    referralPoints: 6,
    displayReferralPoints: 600,
    completedQuests: [1],
    completedChallenges: [1, 2],
    completableChallenges: [3],
    weeklyDrawEligibility: [1, 2],
    availableDrawPrizeAssetIds: [3215542831n],
    claimedDrawPrizeAssetIds: [],
  };

  const profile = buildSdkProfile(
    algolandUser.address,
    algolandUser,
    [
      'EMNETCRVN2B4LYV4BDQ5JFYBJVAK663G2AOEENUV2WZK5U6FS3LNEIWTCU',
      'HHADCZKQV24QDCBER5GTOH7BOLF4ZQ6WICNHAA3GZUECIMJXIIMYBIWEZM',
    ],
  );

  assert.equal(profile.points, 7800);
  assert.equal(profile.pointsRaw, 78);
  assert.equal(profile.redeemedPoints, 1200);
  assert.equal(profile.redeemedPointsRaw, 12);
  assert.equal(profile.referralPoints, 600);
  assert.equal(profile.referralPointsRaw, 6);
  assert.equal(profile.relativeId, 12);
  assert.equal(profile.referrerId, 34);
  assert.equal(profile.status, 'ok');
  assert(profile.hasParticipation);
  assert.equal(profile.weeklyDraws.entries, 2);
  assert(profile.weeklyDraws.eligible);
  assert.deepEqual(profile.weeklyDraws.weeks, ['Challenge 1', 'Challenge 2']);
  assert.deepEqual(profile.availableDrawPrizeAssetIds, ['Asset 3215542831']);
  assert.deepEqual(profile.claimedDrawPrizeAssetIds, []);
  assert.deepEqual(profile.completedQuests, ['Quest 1']);
  assert.deepEqual(profile.completedChallenges, ['Challenge 1', 'Challenge 2']);
  assert.deepEqual(profile.completableChallenges, ['Challenge 3']);
  assert.deepEqual(
    profile.referrals,
    [
      'EMNETCRVN2B4LYV4BDQ5JFYBJVAK663G2AOEENUV2WZK5U6FS3LNEIWTCU',
      'HHADCZKQV24QDCBER5GTOH7BOLF4ZQ6WICNHAA3GZUECIMJXIIMYBIWEZM',
    ],
  );
  assert.equal(profile.referralsCount, 2);
  assert.equal(profile.source, '@algorandfoundation/algoland-sdk');
  assert.equal(profile.referralsRelativeIds.length, 2);
  assert.equal(profile.availableDrawPrizeAssetIds.length, 1);
  assert.ok(typeof profile.updatedAt === 'string');
  assert.ok(typeof profile.raw === 'object');
});
