// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract MockUsdcPriceOracle {
    uint256 public usdcPerEth;

    constructor(uint256 usdcPerEth_) {
        usdcPerEth = usdcPerEth_;
    }

    function setUsdcPerEth(uint256 usdcPerEth_) external {
        usdcPerEth = usdcPerEth_;
    }

    function quoteUsdcForWei(uint256 weiAmount) external view returns (uint256 usdcAmount) {
        usdcAmount = (weiAmount * usdcPerEth) / 1e18;
    }
}
