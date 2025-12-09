// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title ClaraJobNFT
 * @dev NFT for Clara Parabricks GPU variant calling jobs (FASTQ → VCF)
 * Each token represents a completed DeepVariant job and links to BioNFT as derivative
 */
contract ClaraJobNFT is ERC721URIStorage, Ownable {
    uint256 private _nextTokenId;

    // Job data storage
    struct JobData {
        string biosampleSerial;
        string vcfPath;
        string pipeline;
        string referenceGenome;
        bytes32 vcfHash;
        uint256 createdAt;
    }

    mapping(uint256 => JobData) public jobData;
    mapping(string => uint256) public biosampleToTokenId;

    event JobMinted(
        uint256 indexed tokenId,
        string biosampleSerial,
        address indexed owner,
        string vcfPath,
        bytes32 vcfHash
    );

    constructor() ERC721("Clara Genomics Jobs V2", "CLARAV2") {
        _nextTokenId = 1;
    }

    /**
     * @dev Mint a new ClaraJobNFT
     * @param to Address to mint to (typically BioNFT owner)
     * @param biosampleSerial Biosample serial number
     * @param vcfPath S3 path to VCF file
     * @param pipeline Pipeline used (e.g., "deepvariant")
     * @param referenceGenome Reference genome (e.g., "hg38")
     * @param vcfHash Keccak256 hash of VCF path for verification
     * @param metadataUri Token metadata URI
     */
    function mintJob(
        address to,
        string calldata biosampleSerial,
        string calldata vcfPath,
        string calldata pipeline,
        string calldata referenceGenome,
        bytes32 vcfHash,
        string calldata metadataUri
    ) external onlyOwner returns (uint256) {
        require(biosampleToTokenId[biosampleSerial] == 0, "Job already exists for this biosample");

        uint256 tokenId = _nextTokenId++;
        _safeMint(to, tokenId);
        _setTokenURI(tokenId, metadataUri);

        jobData[tokenId] = JobData({
            biosampleSerial: biosampleSerial,
            vcfPath: vcfPath,
            pipeline: pipeline,
            referenceGenome: referenceGenome,
            vcfHash: vcfHash,
            createdAt: block.timestamp
        });

        biosampleToTokenId[biosampleSerial] = tokenId;

        emit JobMinted(tokenId, biosampleSerial, to, vcfPath, vcfHash);

        return tokenId;
    }

    /**
     * @dev Simple safeMint for compatibility
     */
    function safeMint(address to, string calldata uri) external onlyOwner returns (uint256) {
        uint256 tokenId = _nextTokenId++;
        _safeMint(to, tokenId);
        _setTokenURI(tokenId, uri);
        return tokenId;
    }

    function totalSupply() public view returns (uint256) {
        return _nextTokenId - 1;
    }

    function getJobData(uint256 tokenId) external view returns (JobData memory) {
        require(tokenId > 0 && tokenId < _nextTokenId, "Invalid token ID");
        return jobData[tokenId];
    }
}

