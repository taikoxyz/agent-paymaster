// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

contract MockERC20Permit is EIP712 {
    string public constant name = "Mock USDC";
    string public constant symbol = "mUSDC";
    uint8 public constant decimals = 6;

    bytes32 public constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    mapping(address account => uint256) public balanceOf;
    mapping(address owner => mapping(address spender => uint256)) public allowance;
    mapping(address owner => uint256) public nonces;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor() EIP712(name, "2") {}

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 currentAllowance = allowance[from][msg.sender];
        require(currentAllowance >= amount, "INSUFFICIENT_ALLOWANCE");

        if (currentAllowance != type(uint256).max) {
            allowance[from][msg.sender] = currentAllowance - amount;
            emit Approval(from, msg.sender, allowance[from][msg.sender]);
        }

        _transfer(from, to, amount);
        return true;
    }

    function permit(address owner, address spender, uint256 value, uint256 deadline, bytes calldata signature)
        external
    {
        _permit(owner, spender, value, deadline, signature);
    }

    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        _permit(owner, spender, value, deadline, abi.encodePacked(r, s, v));
    }

    function permitDigest(address owner, address spender, uint256 value, uint256 nonce, uint256 deadline)
        external
        view
        returns (bytes32)
    {
        return _hashPermit(owner, spender, value, nonce, deadline);
    }

    function _permit(address owner, address spender, uint256 value, uint256 deadline, bytes memory signature) private {
        require(block.timestamp <= deadline, "PERMIT_DEADLINE_EXPIRED");

        bytes32 digest = _hashPermit(owner, spender, value, nonces[owner], deadline);
        require(SignatureChecker.isValidSignatureNow(owner, digest, signature), "INVALID_PERMIT_SIGNATURE");

        nonces[owner] += 1;
        allowance[owner][spender] = value;
        emit Approval(owner, spender, value);
    }

    function _hashPermit(address owner, address spender, uint256 value, uint256 nonce, uint256 deadline)
        private
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, nonce, deadline)));
    }

    function _transfer(address from, address to, uint256 amount) private {
        require(to != address(0), "INVALID_RECIPIENT");
        require(balanceOf[from] >= amount, "INSUFFICIENT_BALANCE");

        unchecked {
            balanceOf[from] -= amount;
        }
        balanceOf[to] += amount;

        emit Transfer(from, to, amount);
    }
}
