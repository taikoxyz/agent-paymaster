// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";

contract MockERC1271Wallet is IERC1271 {
    bytes4 internal constant _MAGICVALUE = 0x1626ba7e;

    address public immutable signer;

    constructor(address signer_) {
        signer = signer_;
    }

    function isValidSignature(bytes32 hash, bytes memory signature) external view returns (bytes4) {
        (address recovered, ECDSA.RecoverError recoverError,) = ECDSA.tryRecover(hash, signature);
        if (recoverError == ECDSA.RecoverError.NoError && recovered == signer) {
            return _MAGICVALUE;
        }

        return bytes4(0xffffffff);
    }
}
