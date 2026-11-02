// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {KilnCompute} from "../contracts/KilnCompute.sol";

/// @notice Known-answer vectors in this file were computed INDEPENDENTLY of
/// the Solidity under test: integer results with Python bigint arithmetic
/// (exact), hashes with `cast keccak` (real keccak256) over hand-built
/// preimages, digests with `cast abi-encode` + `cast keccak`. Derivations
/// are noted per section so any vector can be reproduced off-chain.
contract KilnComputeTest is Test {
    // ---------------- Merkle ----------------
    // Leaves are keccak256 of the ASCII names; parents are keccak256 of the
    // raw 64-byte concatenation (left || right), computed with cast.
    bytes32 internal l0 = bytes32(0x6dfc21ac0c8c2db036305d8bc6f887630d35e156f37d5a7e2275bc05bc004846); // "alpha"
    bytes32 internal l1 = bytes32(0x9cfe0dc181c89029f2b16763070c20922901f0c18e094710477b8fecf8b78476); // "beta"
    bytes32 internal l2 = bytes32(0x8ec2a252e6833332e4d11a94054bb27c27c7220a2efddc664860650b61f98fc2); // "gamma"
    bytes32 internal l3 = bytes32(0xe0d399e873cde9f1130182a2b70db45e021df5a2f404fa14e8b2f7481c10f1d3); // "delta"
    bytes32 internal h01 = bytes32(0xf2bcd1be4a21fd37ce1dc9f9f35f3ab6759a6e720008a0e7da84c29090d303a9);
    bytes32 internal h23 = bytes32(0xb20357101cf1578fe547ee3890215f1ed942bc70b843e374e6528397fc834870);
    bytes32 internal root4 = bytes32(0x2fe5d026cb8de391a89e37f583c2b7dabf0d87ffbd25bb588b43cb7a56d9afb9);
    // 3-leaf tree under duplicate-the-odd-node: h22 = keccak(l2 || l2),
    // root = keccak(h01 || h22). Both computed with cast.
    bytes32 internal h22 = bytes32(0x07fd583f032089b6a516b6823f174890e1f96c2eba9a620175e7eb06f42ec9fb);
    bytes32 internal root3 = bytes32(0x940e9ce1c3b6cca130e0ebeda037efd448dfa8b1fd43b2e59749768511b11f83);

    function testLeafHashMatchesKnownLeaf() public view {
        assertEq(KilnCompute.leafHash("alpha"), l0);
        assertEq(KilnCompute.hashPair(l0, l1), h01);
    }

    function testVerifyLeafFourLeafTree() public view {
        bytes32[] memory proof0 = new bytes32[](2);
        proof0[0] = l1;
        proof0[1] = h23;
        assertTrue(KilnCompute.verifyLeaf(root4, l0, proof0, 0));

        bytes32[] memory proof2 = new bytes32[](2);
        proof2[0] = l3;
        proof2[1] = h01;
        assertTrue(KilnCompute.verifyLeaf(root4, l2, proof2, 2));

        bytes32[] memory proof3 = new bytes32[](2);
        proof3[0] = l2;
        proof3[1] = h01;
        assertTrue(KilnCompute.verifyLeaf(root4, l3, proof3, 3));
    }

    function testVerifyLeafRejectsWrongIndexAndTamperedProof() public view {
        bytes32[] memory proof0 = new bytes32[](2);
        proof0[0] = l1;
        proof0[1] = h23;
        // Same proof, wrong claimed position.
        assertFalse(KilnCompute.verifyLeaf(root4, l0, proof0, 1));
        // Same proof, leaf swapped for a different leaf.
        assertFalse(KilnCompute.verifyLeaf(root4, l1, proof0, 0));
        // Tampered sibling.
        proof0[0] = l2;
        assertFalse(KilnCompute.verifyLeaf(root4, l0, proof0, 0));
        // Wrong root.
        bytes32[] memory proof2 = new bytes32[](2);
        proof2[0] = l3;
        proof2[1] = h01;
        assertFalse(KilnCompute.verifyLeaf(root3, l2, proof2, 2));
    }

    function testVerifyLeafDuplicatedOddNode() public view {
        // In the 3-leaf tree gamma (index 2) is the odd node of its level:
        // it is duplicated (hashed with itself), so its proof is
        // [itself, h01] — full depth, like every other leaf.
        assertEq(KilnCompute.hashPair(l2, l2), h22);
        bytes32[] memory proof = new bytes32[](2);
        proof[0] = l2;
        proof[1] = h01;
        assertTrue(KilnCompute.verifyLeaf(root3, l2, proof, 2));
        // And the even leaves of the same tree verify against the same root.
        bytes32[] memory proof0 = new bytes32[](2);
        proof0[0] = l1;
        proof0[1] = h22;
        assertTrue(KilnCompute.verifyLeaf(root3, l0, proof0, 0));
    }

    // ---------------- Hash chain ----------------
    // genesis = keccak256("kiln-genesis"); entries = keccak256("entry-N");
    // heads = fold of keccak256(prev || entry), all computed with cast.
    bytes32 internal genesis = bytes32(0xd8ac397d46086ab92703b59bb1ba8d17f3bfcd2419e0e5c3fe0aedce3b83dd49);
    bytes32 internal e1 = bytes32(0xe17069d2becc0791c8bf2b3a01e11ef69442dabc3aa8cbd542ebaeceee992934);
    bytes32 internal e2 = bytes32(0x1c4d633296d87c866fc928b42caf6157d307412343ae17755afb5cc9812896e1);
    bytes32 internal e3 = bytes32(0xb8fa5b56d254e7b0024b1b08f755609a2ccb347cbb11761193d3fad37a94fb88);
    bytes32 internal n1 = bytes32(0x58279c963e3c285ccb87b4324275f66c953b95518e45c2f5aed8ebeb90260217);
    bytes32 internal n2 = bytes32(0xbba1d9ca3d8b98a1d5d0b80b3285accc951519d13decafefceae4fd6f6a5047e);
    bytes32 internal n3 = bytes32(0x876bdf8bc1cae93b3a0f285100bc2dad7dba632e61b169b08d76f7ba4054d17a);

    function entries() internal view returns (bytes32[] memory es) {
        es = new bytes32[](3);
        es[0] = e1;
        es[1] = e2;
        es[2] = e3;
    }

    function testChainStep() public view {
        assertEq(KilnCompute.chainStep(genesis, e1), n1);
        assertTrue(KilnCompute.verifyChainStep(n1, e2, n2));
        assertFalse(KilnCompute.verifyChainStep(n1, e2, n3));
        assertFalse(KilnCompute.verifyChainStep(n1, e3, n2));
    }

    function testChainSegment() public view {
        assertEq(KilnCompute.chainSegment(genesis, entries()), n3);
        assertTrue(KilnCompute.verifyChainSegment(genesis, entries(), n3));
        // Tamper: swap two entries — the fold must break.
        bytes32[] memory es = entries();
        es[1] = e3;
        es[2] = e2;
        assertFalse(KilnCompute.verifyChainSegment(genesis, es, n3));
        // Empty segment returns the start hash unchanged.
        bytes32[] memory none = new bytes32[](0);
        assertEq(KilnCompute.chainSegment(genesis, none), genesis);
        assertTrue(KilnCompute.verifyChainSegment(genesis, none, genesis));
    }

    // ---------------- Dot product ----------------
    // Python: sum(x*y) for a=[3,-2,5,10**18], b=[4,7,-1,2]
    //       = 12 - 14 - 5 + 2*10**18 = 1999999999999999993.
    function testDotKnownAnswer() public view {
        int256[] memory a = new int256[](4);
        a[0] = 3;
        a[1] = -2;
        a[2] = 5;
        a[3] = 1e18;
        int256[] memory b = new int256[](4);
        b[0] = 4;
        b[1] = 7;
        b[2] = -1;
        b[3] = 2;
        assertEq(KilnCompute.dot(a, b), 1999999999999999993);
        assertTrue(KilnCompute.verifyDot(a, b, 1999999999999999993));
        assertFalse(KilnCompute.verifyDot(a, b, 1999999999999999992));
    }

    function testDotLengthMismatchReverts() public {
        int256[] memory a = new int256[](2);
        int256[] memory b = new int256[](3);
        vm.expectRevert(KilnCompute.LengthMismatch.selector);
        KilnCompute.dot(a, b);
    }

    // ---------------- Matmul element ----------------
    function testMatmulElementKnownAnswers() public view {
        int256[] memory row = new int256[](3);
        row[0] = 1;
        row[1] = 2;
        row[2] = 3;
        int256[] memory col = new int256[](3);
        col[0] = 4;
        col[1] = 5;
        col[2] = 6;
        // 1*4 + 2*5 + 3*6 = 32.
        assertTrue(KilnCompute.verifyMatmulElement(row, col, 32));
        assertFalse(KilnCompute.verifyMatmulElement(row, col, 31));
    }

    function testMatmulElementFixedPoint() public view {
        // Scale S = 1e18: row = [1.5, -0.5], col = [2, 4] (scaled).
        // Python: 1500000000000000000*2000000000000000000
        //       + (-500000000000000000)*4000000000000000000 = 10**36.
        int256[] memory row = new int256[](2);
        row[0] = 1500000000000000000;
        row[1] = -500000000000000000;
        int256[] memory col = new int256[](2);
        col[0] = 2000000000000000000;
        col[1] = 4000000000000000000;
        assertTrue(KilnCompute.verifyMatmulElement(row, col, 1e36));
        assertFalse(KilnCompute.verifyMatmulElement(row, col, 1e36 - 1));
    }

    function testMatmulElementCommittedDigests() public view {
        int256[] memory row = new int256[](3);
        row[0] = 1;
        row[1] = 2;
        row[2] = 3;
        int256[] memory col = new int256[](3);
        col[0] = 4;
        col[1] = 5;
        col[2] = 6;
        bytes32 rowCommit = KilnCompute.digestVector(row);
        bytes32 colCommit = KilnCompute.digestVector(col);
        assertTrue(KilnCompute.verifyMatmulElementCommitted(rowCommit, colCommit, row, col, 32));
        // A different row under the same claimed commit is refused.
        row[2] = 4;
        assertFalse(KilnCompute.verifyMatmulElementCommitted(rowCommit, colCommit, row, col, 32));
        // The genuine row under a wrong commit is refused.
        row[2] = 3;
        assertFalse(KilnCompute.verifyMatmulElementCommitted(colCommit, colCommit, row, col, 32));
        // Genuine vectors + commits, wrong element claim is refused.
        assertFalse(KilnCompute.verifyMatmulElementCommitted(rowCommit, colCommit, row, col, 33));
    }

    function testDigestVectorKnownAnswer() public view {
        int256[] memory x = new int256[](3);
        x[0] = 3;
        x[1] = -4;
        x[2] = 12;
        // cast keccak $(cast abi-encode "f(int256[])" "[3,-4,12]")
        assertEq(KilnCompute.digestVector(x), bytes32(0xc14756765f6cb99c0883ebf260bedb8050e68a09934d45b850d8ff3b429c7cb4));
    }

    // ---------------- Sum of squares / RMS ----------------
    // Python exact math: [3,-4,12] -> sumsq 169, mean 56 (floor), rms 7.
    // [2,2,2,2] -> 16, 4, 2. [3e18, 4e18] -> 25e36, 125e35, isqrt = below.
    function testSumSquaresAndRmsKnownAnswers() public view {
        int256[] memory x = new int256[](3);
        x[0] = 3;
        x[1] = -4;
        x[2] = 12;
        assertEq(KilnCompute.sumSquares(x), 169);
        assertEq(KilnCompute.meanSquare(x), 56);
        assertEq(KilnCompute.rms(x), 7);
        // cast keccak $(cast abi-encode "f(int256,uint256)" 169 3)
        assertEq(KilnCompute.rmsDigest(x), bytes32(0x26b3a75f1090b919a7e2970e6a8cf186173d1f9e583e60add70c84168934db1b));

        int256[] memory y = new int256[](4);
        y[0] = 2;
        y[1] = 2;
        y[2] = 2;
        y[3] = 2;
        assertEq(KilnCompute.sumSquares(y), 16);
        assertEq(KilnCompute.meanSquare(y), 4);
        assertEq(KilnCompute.rms(y), 2);

        int256[] memory z = new int256[](2);
        z[0] = 3e18;
        z[1] = 4e18;
        assertEq(KilnCompute.sumSquares(z), 25e36);
        assertEq(KilnCompute.meanSquare(z), 12500000000000000000000000000000000000);
        // Python math.isqrt(12500000000000000000000000000000000000).
        assertEq(KilnCompute.rms(z), 3535533905932737622);
    }

    function testRmsEmptyVectorReverts() public {
        int256[] memory x = new int256[](0);
        vm.expectRevert(KilnCompute.EmptyVector.selector);
        KilnCompute.meanSquare(x);
        vm.expectRevert(KilnCompute.EmptyVector.selector);
        KilnCompute.rms(x);
    }

    // ---------------- isqrt ----------------
    // Python math.isqrt for every case, including the uint256 maximum
    // (isqrt(2**256 - 1) = 2**128 - 1 = 340282366920938463463374607431768211455).
    function testIsqrtKnownAnswers() public view {
        assertEq(KilnCompute.isqrt(0), 0);
        assertEq(KilnCompute.isqrt(1), 1);
        assertEq(KilnCompute.isqrt(2), 1);
        assertEq(KilnCompute.isqrt(3), 1);
        assertEq(KilnCompute.isqrt(4), 2);
        assertEq(KilnCompute.isqrt(56), 7);
        assertEq(KilnCompute.isqrt(1e36), 1e18);
        assertEq(KilnCompute.isqrt(type(uint256).max), 340282366920938463463374607431768211455);
    }
}
