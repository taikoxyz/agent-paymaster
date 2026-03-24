// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IEntryPoint} from "account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {SIG_VALIDATION_FAILED, SIG_VALIDATION_SUCCESS} from "account-abstraction/contracts/core/Helpers.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {ServoAccount} from "../src/ServoAccount.sol";
import {ServoAccountFactory} from "../src/ServoAccountFactory.sol";
import {MockEntryPoint} from "./mocks/MockEntryPoint.sol";
import {MockERC20Permit} from "./mocks/MockERC20Permit.sol";

contract ExecuteTarget {
    uint256 public value;

    function setValue(uint256 newValue) external payable {
        value = newValue;
    }

    function willRevert() external pure {
        revert("TARGET_REVERT");
    }
}

contract MockERC721 is ERC721 {
    constructor() ERC721("Mock Registry", "MOCK") {}

    function safeMint(address to, uint256 tokenId) external {
        _safeMint(to, tokenId);
    }
}

contract ServoAccountFactoryTest is Test {
    MockEntryPoint internal entryPoint;
    ServoAccountFactory internal factory;

    uint256 internal ownerKey;
    uint256 internal otherKey;
    address internal owner;
    address internal otherSigner;

    function setUp() public {
        entryPoint = new MockEntryPoint();
        factory = new ServoAccountFactory(IEntryPoint(address(entryPoint)));

        ownerKey = 0xA11CE;
        otherKey = 0xB0B;
        owner = vm.addr(ownerKey);
        otherSigner = vm.addr(otherKey);
    }

    function test_factoryCreateAccountMatchesPrediction() public {
        uint256 salt = 1234;
        address predicted = factory.getAddress(owner, salt);

        address created = factory.createAccount(owner, salt);
        assertEq(created, predicted);
        assertEq(factory.createAccount(owner, salt), predicted);

        ServoAccount account = ServoAccount(payable(created));
        assertEq(account.owner(), owner);
        assertEq(address(account.entryPoint()), address(entryPoint));
    }

    function test_factoryAddressChangesAcrossOwnersOrSalts() public view {
        uint256 salt = 1234;
        address ownerB = address(0xBEEF);

        assertTrue(factory.getAddress(owner, salt) != factory.getAddress(ownerB, salt));
        assertTrue(factory.getAddress(owner, salt) != factory.getAddress(owner, salt + 1));
    }

    function test_validateUserOpAcceptsOwnerSignature() public {
        ServoAccount account = _deployAccount();
        bytes32 userOpHash = keccak256("servo:userop:ok");

        PackedUserOperation memory userOp;
        userOp.sender = address(account);
        userOp.signature = _signEthMessage(ownerKey, userOpHash);

        vm.prank(address(entryPoint));
        uint256 validationData = account.validateUserOp(userOp, userOpHash, 0);
        assertEq(validationData, SIG_VALIDATION_SUCCESS);
    }

    function test_validateUserOpRejectsWrongSigner() public {
        ServoAccount account = _deployAccount();
        bytes32 userOpHash = keccak256("servo:userop:bad");

        PackedUserOperation memory userOp;
        userOp.sender = address(account);
        userOp.signature = _signEthMessage(otherKey, userOpHash);

        vm.prank(address(entryPoint));
        uint256 validationData = account.validateUserOp(userOp, userOpHash, 0);
        assertEq(validationData, SIG_VALIDATION_FAILED);
    }

    function test_executeByOwnerAndEntryPoint() public {
        ServoAccount account = _deployAccount();
        ExecuteTarget target = new ExecuteTarget();

        vm.prank(owner);
        account.execute(address(target), 0, abi.encodeCall(ExecuteTarget.setValue, (11)));
        assertEq(target.value(), 11);

        vm.prank(address(entryPoint));
        account.execute(address(target), 0, abi.encodeCall(ExecuteTarget.setValue, (22)));
        assertEq(target.value(), 22);
    }

    function test_executeBatchByOwner() public {
        ServoAccount account = _deployAccount();
        ExecuteTarget targetOne = new ExecuteTarget();
        ExecuteTarget targetTwo = new ExecuteTarget();

        address[] memory targets = new address[](2);
        uint256[] memory values = new uint256[](2);
        bytes[] memory calldatas = new bytes[](2);

        targets[0] = address(targetOne);
        targets[1] = address(targetTwo);
        values[0] = 0;
        values[1] = 0;
        calldatas[0] = abi.encodeCall(ExecuteTarget.setValue, (1));
        calldatas[1] = abi.encodeCall(ExecuteTarget.setValue, (2));

        vm.prank(owner);
        account.executeBatch(targets, values, calldatas);

        assertEq(targetOne.value(), 1);
        assertEq(targetTwo.value(), 2);
    }

    function test_revertsWhenUnauthorized() public {
        ServoAccount account = _deployAccount();
        ExecuteTarget target = new ExecuteTarget();

        vm.expectRevert(ServoAccount.Unauthorized.selector);
        account.execute(address(target), 0, abi.encodeCall(ExecuteTarget.setValue, (1)));

        address[] memory targets = new address[](1);
        uint256[] memory values = new uint256[](1);
        bytes[] memory calldatas = new bytes[](1);
        targets[0] = address(target);
        values[0] = 0;
        calldatas[0] = abi.encodeCall(ExecuteTarget.setValue, (1));

        vm.expectRevert(ServoAccount.Unauthorized.selector);
        account.executeBatch(targets, values, calldatas);
    }

    function test_revertsWhenExecuteBatchLengthsMismatch() public {
        ServoAccount account = _deployAccount();

        address[] memory targets = new address[](2);
        uint256[] memory values = new uint256[](1);
        bytes[] memory calldatas = new bytes[](2);

        vm.prank(owner);
        vm.expectRevert(ServoAccount.ArrayLengthMismatch.selector);
        account.executeBatch(targets, values, calldatas);
    }

    function test_executeBubblesTargetRevert() public {
        ServoAccount account = _deployAccount();
        ExecuteTarget target = new ExecuteTarget();

        vm.prank(owner);
        vm.expectRevert(bytes("TARGET_REVERT"));
        account.execute(address(target), 0, abi.encodeCall(ExecuteTarget.willRevert, ()));
    }

    function test_permitFlowUsesErc1271Signature() public {
        ServoAccount account = _deployAccount();
        MockERC20Permit token = new MockERC20Permit();

        address spender = address(0xCAFE);
        uint256 value = 1_500_000;
        uint256 deadline = block.timestamp + 1 hours;
        uint256 nonce = token.nonces(address(account));
        bytes32 digest = token.permitDigest(address(account), spender, value, nonce, deadline);
        bytes memory permitSignature = _signDigest(ownerKey, digest);

        token.permit(address(account), spender, value, deadline, permitSignature);

        assertEq(token.allowance(address(account), spender), value);
        assertEq(token.nonces(address(account)), nonce + 1);
    }

    function test_safeMintToAccountSucceeds() public {
        ServoAccount account = _deployAccount();
        MockERC721 token = new MockERC721();

        token.safeMint(address(account), 1);

        assertEq(token.ownerOf(1), address(account));
        assertEq(token.balanceOf(address(account)), 1);
    }

    function test_safeTransferToAccountSucceeds() public {
        ServoAccount account = _deployAccount();
        MockERC721 token = new MockERC721();

        token.safeMint(owner, 1);

        vm.prank(owner);
        token.safeTransferFrom(owner, address(account), 1);

        assertEq(token.ownerOf(1), address(account));
        assertEq(token.balanceOf(address(account)), 1);
    }

    function _deployAccount() internal returns (ServoAccount) {
        return ServoAccount(payable(factory.createAccount(owner, 111)));
    }

    function _signEthMessage(uint256 signerKey, bytes32 messageHash) internal pure returns (bytes memory) {
        return _signDigest(signerKey, MessageHashUtils.toEthSignedMessageHash(messageHash));
    }

    function _signDigest(uint256 signerKey, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        return abi.encodePacked(r, s, v);
    }
}
