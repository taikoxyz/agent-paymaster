// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PaymasterStub} from "./PaymasterStub.sol";

contract PaymasterStubTest is Test {
    PaymasterStub stub;

    function setUp() public {
        stub = new PaymasterStub();
    }

    function test_setsDeployerAsOwner() public view {
        assertEq(stub.owner(), address(this));
    }

    function test_allowsOwnerToEmitSponsored() public {
        address account = makeAddr("account");

        vm.expectEmit(true, true, false, true);
        emit PaymasterStub.Sponsored(address(this), account, 1_000);

        stub.sponsor(account, 1_000);
    }
}
