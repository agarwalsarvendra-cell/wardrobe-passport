// ABI of WardrobePassportV2 (generated from contracts/WardrobePassportV2.sol)
window.WP_ABI = [
 {
  "inputs": [],
  "stateMutability": "nonpayable",
  "type": "constructor"
 },
 {
  "inputs": [],
  "name": "CannotBuyOwnItem",
  "type": "error"
 },
 {
  "inputs": [],
  "name": "ConflictOfInterest",
  "type": "error"
 },
 {
  "inputs": [],
  "name": "InvalidPartner",
  "type": "error"
 },
 {
  "inputs": [],
  "name": "InvalidPrice",
  "type": "error"
 },
 {
  "inputs": [],
  "name": "NoSuchItem",
  "type": "error"
 },
 {
  "inputs": [],
  "name": "NotAdmin",
  "type": "error"
 },
 {
  "inputs": [],
  "name": "NotBuyer",
  "type": "error"
 },
 {
  "inputs": [],
  "name": "NotOwner",
  "type": "error"
 },
 {
  "inputs": [],
  "name": "NotPartner",
  "type": "error"
 },
 {
  "inputs": [],
  "name": "NothingOwed",
  "type": "error"
 },
 {
  "inputs": [],
  "name": "PartnerExists",
  "type": "error"
 },
 {
  "inputs": [],
  "name": "TooEarly",
  "type": "error"
 },
 {
  "inputs": [],
  "name": "TransferFailed",
  "type": "error"
 },
 {
  "inputs": [],
  "name": "WrongAmount",
  "type": "error"
 },
 {
  "inputs": [],
  "name": "WrongStatus",
  "type": "error"
 },
 {
  "anonymous": false,
  "inputs": [
   {
    "indexed": true,
    "internalType": "uint256",
    "name": "id",
    "type": "uint256"
   },
   {
    "indexed": true,
    "internalType": "address",
    "name": "partner",
    "type": "address"
   },
   {
    "indexed": false,
    "internalType": "string",
    "name": "note",
    "type": "string"
   }
  ],
  "name": "Authenticated",
  "type": "event"
 },
 {
  "anonymous": false,
  "inputs": [
   {
    "indexed": true,
    "internalType": "uint256",
    "name": "id",
    "type": "uint256"
   },
   {
    "indexed": true,
    "internalType": "address",
    "name": "seller",
    "type": "address"
   },
   {
    "indexed": false,
    "internalType": "uint256",
    "name": "amount",
    "type": "uint256"
   }
  ],
  "name": "DepositForfeited",
  "type": "event"
 },
 {
  "anonymous": false,
  "inputs": [
   {
    "indexed": true,
    "internalType": "uint256",
    "name": "id",
    "type": "uint256"
   },
   {
    "indexed": true,
    "internalType": "address",
    "name": "buyer",
    "type": "address"
   },
   {
    "indexed": false,
    "internalType": "string",
    "name": "reason",
    "type": "string"
   }
  ],
  "name": "DisputeOpened",
  "type": "event"
 },
 {
  "anonymous": false,
  "inputs": [
   {
    "indexed": true,
    "internalType": "uint256",
    "name": "id",
    "type": "uint256"
   },
   {
    "indexed": true,
    "internalType": "address",
    "name": "partner",
    "type": "address"
   },
   {
    "indexed": false,
    "internalType": "bool",
    "name": "buyerWins",
    "type": "bool"
   }
  ],
  "name": "DisputeResolved",
  "type": "event"
 },
 {
  "anonymous": false,
  "inputs": [
   {
    "indexed": true,
    "internalType": "uint256",
    "name": "id",
    "type": "uint256"
   },
   {
    "indexed": false,
    "internalType": "uint256",
    "name": "price",
    "type": "uint256"
   },
   {
    "indexed": false,
    "internalType": "uint256",
    "name": "deposit",
    "type": "uint256"
   },
   {
    "indexed": true,
    "internalType": "address",
    "name": "partner",
    "type": "address"
   }
  ],
  "name": "Listed",
  "type": "event"
 },
 {
  "anonymous": false,
  "inputs": [
   {
    "indexed": true,
    "internalType": "uint256",
    "name": "id",
    "type": "uint256"
   }
  ],
  "name": "ListingCancelled",
  "type": "event"
 },
 {
  "anonymous": false,
  "inputs": [
   {
    "indexed": true,
    "internalType": "address",
    "name": "partner",
    "type": "address"
   },
   {
    "indexed": false,
    "internalType": "string",
    "name": "name",
    "type": "string"
   },
   {
    "indexed": false,
    "internalType": "string",
    "name": "city",
    "type": "string"
   }
  ],
  "name": "PartnerAdded",
  "type": "event"
 },
 {
  "anonymous": false,
  "inputs": [
   {
    "indexed": true,
    "internalType": "address",
    "name": "partner",
    "type": "address"
   },
   {
    "indexed": false,
    "internalType": "bool",
    "name": "active",
    "type": "bool"
   }
  ],
  "name": "PartnerStatusChanged",
  "type": "event"
 },
 {
  "anonymous": false,
  "inputs": [
   {
    "indexed": true,
    "internalType": "uint256",
    "name": "id",
    "type": "uint256"
   },
   {
    "indexed": true,
    "internalType": "address",
    "name": "owner",
    "type": "address"
   },
   {
    "indexed": false,
    "internalType": "string",
    "name": "name",
    "type": "string"
   },
   {
    "indexed": false,
    "internalType": "string",
    "name": "brand",
    "type": "string"
   }
  ],
  "name": "PassportCreated",
  "type": "event"
 },
 {
  "anonymous": false,
  "inputs": [
   {
    "indexed": true,
    "internalType": "address",
    "name": "to",
    "type": "address"
   },
   {
    "indexed": false,
    "internalType": "uint256",
    "name": "amount",
    "type": "uint256"
   }
  ],
  "name": "PayoutDeferred",
  "type": "event"
 },
 {
  "anonymous": false,
  "inputs": [
   {
    "indexed": true,
    "internalType": "uint256",
    "name": "id",
    "type": "uint256"
   },
   {
    "indexed": true,
    "internalType": "address",
    "name": "buyer",
    "type": "address"
   },
   {
    "indexed": false,
    "internalType": "uint256",
    "name": "price",
    "type": "uint256"
   }
  ],
  "name": "Purchased",
  "type": "event"
 },
 {
  "anonymous": false,
  "inputs": [
   {
    "indexed": true,
    "internalType": "uint256",
    "name": "id",
    "type": "uint256"
   },
   {
    "indexed": true,
    "internalType": "address",
    "name": "buyer",
    "type": "address"
   },
   {
    "indexed": false,
    "internalType": "uint256",
    "name": "amount",
    "type": "uint256"
   }
  ],
  "name": "Refunded",
  "type": "event"
 },
 {
  "anonymous": false,
  "inputs": [
   {
    "indexed": true,
    "internalType": "uint256",
    "name": "id",
    "type": "uint256"
   },
   {
    "indexed": true,
    "internalType": "address",
    "name": "from",
    "type": "address"
   },
   {
    "indexed": true,
    "internalType": "address",
    "name": "to",
    "type": "address"
   },
   {
    "indexed": false,
    "internalType": "uint256",
    "name": "price",
    "type": "uint256"
   },
   {
    "indexed": false,
    "internalType": "uint256",
    "name": "partnerFee",
    "type": "uint256"
   }
  ],
  "name": "SaleCompleted",
  "type": "event"
 },
 {
  "anonymous": false,
  "inputs": [
   {
    "indexed": true,
    "internalType": "uint256",
    "name": "id",
    "type": "uint256"
   }
  ],
  "name": "Shipped",
  "type": "event"
 },
 {
  "anonymous": false,
  "inputs": [
   {
    "indexed": true,
    "internalType": "address",
    "name": "to",
    "type": "address"
   },
   {
    "indexed": false,
    "internalType": "uint256",
    "name": "amount",
    "type": "uint256"
   }
  ],
  "name": "Withdrawn",
  "type": "event"
 },
 {
  "inputs": [],
  "name": "CONFIRM_WINDOW",
  "outputs": [
   {
    "internalType": "uint64",
    "name": "",
    "type": "uint64"
   }
  ],
  "stateMutability": "view",
  "type": "function"
 },
 {
  "inputs": [],
  "name": "DEPOSIT_BPS",
  "outputs": [
   {
    "internalType": "uint256",
    "name": "",
    "type": "uint256"
   }
  ],
  "stateMutability": "view",
  "type": "function"
 },
 {
  "inputs": [],
  "name": "PARTNER_FEE_BPS",
  "outputs": [
   {
    "internalType": "uint256",
    "name": "",
    "type": "uint256"
   }
  ],
  "stateMutability": "view",
  "type": "function"
 },
 {
  "inputs": [],
  "name": "SHIP_WINDOW",
  "outputs": [
   {
    "internalType": "uint64",
    "name": "",
    "type": "uint64"
   }
  ],
  "stateMutability": "view",
  "type": "function"
 },
 {
  "inputs": [
   {
    "internalType": "address",
    "name": "partner",
    "type": "address"
   },
   {
    "internalType": "string",
    "name": "name",
    "type": "string"
   },
   {
    "internalType": "string",
    "name": "city",
    "type": "string"
   }
  ],
  "name": "addPartner",
  "outputs": [],
  "stateMutability": "nonpayable",
  "type": "function"
 },
 {
  "inputs": [],
  "name": "admin",
  "outputs": [
   {
    "internalType": "address",
    "name": "",
    "type": "address"
   }
  ],
  "stateMutability": "view",
  "type": "function"
 },
 {
  "inputs": [
   {
    "internalType": "uint256",
    "name": "id",
    "type": "uint256"
   },
   {
    "internalType": "string",
    "name": "note",
    "type": "string"
   }
  ],
  "name": "authenticate",
  "outputs": [],
  "stateMutability": "nonpayable",
  "type": "function"
 },
 {
  "inputs": [
   {
    "internalType": "uint256",
    "name": "id",
    "type": "uint256"
   }
  ],
  "name": "buy",
  "outputs": [],
  "stateMutability": "payable",
  "type": "function"
 },
 {
  "inputs": [
   {
    "internalType": "uint256",
    "name": "id",
    "type": "uint256"
   }
  ],
  "name": "buyerCancelUnshipped",
  "outputs": [],
  "stateMutability": "nonpayable",
  "type": "function"
 },
 {
  "inputs": [
   {
    "internalType": "uint256",
    "name": "id",
    "type": "uint256"
   }
  ],
  "name": "cancelListing",
  "outputs": [],
  "stateMutability": "nonpayable",
  "type": "function"
 },
 {
  "inputs": [
   {
    "internalType": "uint256",
    "name": "id",
    "type": "uint256"
   }
  ],
  "name": "confirmDelivery",
  "outputs": [],
  "stateMutability": "nonpayable",
  "type": "function"
 },
 {
  "inputs": [
   {
    "internalType": "string",
    "name": "name",
    "type": "string"
   },
   {
    "internalType": "string",
    "name": "brand",
    "type": "string"
   },
   {
    "internalType": "string",
    "name": "details",
    "type": "string"
   },
   {
    "internalType": "string",
    "name": "imageUrl",
    "type": "string"
   }
  ],
  "name": "createPassport",
  "outputs": [
   {
    "internalType": "uint256",
    "name": "id",
    "type": "uint256"
   }
  ],
  "stateMutability": "nonpayable",
  "type": "function"
 },
 {
  "inputs": [
   {
    "internalType": "uint256",
    "name": "price",
    "type": "uint256"
   }
  ],
  "name": "depositFor",
  "outputs": [
   {
    "internalType": "uint256",
    "name": "",
    "type": "uint256"
   }
  ],
  "stateMutability": "pure",
  "type": "function"
 },
 {
  "inputs": [
   {
    "internalType": "uint256",
    "name": "id",
    "type": "uint256"
   }
  ],
  "name": "getHistory",
  "outputs": [
   {
    "components": [
     {
      "internalType": "address",
      "name": "from",
      "type": "address"
     },
     {
      "internalType": "address",
      "name": "to",
      "type": "address"
     },
     {
      "internalType": "uint256",
      "name": "price",
      "type": "uint256"
     },
     {
      "internalType": "uint64",
      "name": "at",
      "type": "uint64"
     }
    ],
    "internalType": "struct WardrobePassportV2.Transfer[]",
    "name": "",
    "type": "tuple[]"
   }
  ],
  "stateMutability": "view",
  "type": "function"
 },
 {
  "inputs": [
   {
    "internalType": "uint256",
    "name": "id",
    "type": "uint256"
   }
  ],
  "name": "getItem",
  "outputs": [
   {
    "components": [
     {
      "internalType": "string",
      "name": "name",
      "type": "string"
     },
     {
      "internalType": "string",
      "name": "brand",
      "type": "string"
     },
     {
      "internalType": "string",
      "name": "details",
      "type": "string"
     },
     {
      "internalType": "string",
      "name": "imageUrl",
      "type": "string"
     },
     {
      "internalType": "address",
      "name": "owner",
      "type": "address"
     },
     {
      "internalType": "address",
      "name": "buyer",
      "type": "address"
     },
     {
      "internalType": "address",
      "name": "partner",
      "type": "address"
     },
     {
      "internalType": "address",
      "name": "authBy",
      "type": "address"
     },
     {
      "internalType": "uint256",
      "name": "price",
      "type": "uint256"
     },
     {
      "internalType": "uint256",
      "name": "deposit",
      "type": "uint256"
     },
     {
      "internalType": "uint64",
      "name": "paidAt",
      "type": "uint64"
     },
     {
      "internalType": "uint64",
      "name": "shippedAt",
      "type": "uint64"
     },
     {
      "internalType": "uint64",
      "name": "authAt",
      "type": "uint64"
     },
     {
      "internalType": "enum WardrobePassportV2.Status",
      "name": "status",
      "type": "uint8"
     },
     {
      "internalType": "string",
      "name": "authNote",
      "type": "string"
     },
     {
      "internalType": "string",
      "name": "disputeReason",
      "type": "string"
     }
    ],
    "internalType": "struct WardrobePassportV2.Item",
    "name": "",
    "type": "tuple"
   }
  ],
  "stateMutability": "view",
  "type": "function"
 },
 {
  "inputs": [],
  "name": "getPartners",
  "outputs": [
   {
    "internalType": "address[]",
    "name": "",
    "type": "address[]"
   }
  ],
  "stateMutability": "view",
  "type": "function"
 },
 {
  "inputs": [],
  "name": "itemCount",
  "outputs": [
   {
    "internalType": "uint256",
    "name": "",
    "type": "uint256"
   }
  ],
  "stateMutability": "view",
  "type": "function"
 },
 {
  "inputs": [
   {
    "internalType": "uint256",
    "name": "id",
    "type": "uint256"
   },
   {
    "internalType": "uint256",
    "name": "price",
    "type": "uint256"
   },
   {
    "internalType": "address",
    "name": "partner",
    "type": "address"
   }
  ],
  "name": "listForSale",
  "outputs": [],
  "stateMutability": "payable",
  "type": "function"
 },
 {
  "inputs": [
   {
    "internalType": "uint256",
    "name": "id",
    "type": "uint256"
   }
  ],
  "name": "markShipped",
  "outputs": [],
  "stateMutability": "nonpayable",
  "type": "function"
 },
 {
  "inputs": [
   {
    "internalType": "uint256",
    "name": "id",
    "type": "uint256"
   },
   {
    "internalType": "string",
    "name": "reason",
    "type": "string"
   }
  ],
  "name": "openDispute",
  "outputs": [],
  "stateMutability": "nonpayable",
  "type": "function"
 },
 {
  "inputs": [
   {
    "internalType": "address",
    "name": "",
    "type": "address"
   }
  ],
  "name": "owed",
  "outputs": [
   {
    "internalType": "uint256",
    "name": "",
    "type": "uint256"
   }
  ],
  "stateMutability": "view",
  "type": "function"
 },
 {
  "inputs": [
   {
    "internalType": "address",
    "name": "",
    "type": "address"
   }
  ],
  "name": "partners",
  "outputs": [
   {
    "internalType": "string",
    "name": "name",
    "type": "string"
   },
   {
    "internalType": "string",
    "name": "city",
    "type": "string"
   },
   {
    "internalType": "bool",
    "name": "active",
    "type": "bool"
   },
   {
    "internalType": "uint32",
    "name": "authenticated",
    "type": "uint32"
   },
   {
    "internalType": "uint32",
    "name": "disputesResolved",
    "type": "uint32"
   }
  ],
  "stateMutability": "view",
  "type": "function"
 },
 {
  "inputs": [
   {
    "internalType": "address",
    "name": "",
    "type": "address"
   }
  ],
  "name": "records",
  "outputs": [
   {
    "internalType": "uint32",
    "name": "sold",
    "type": "uint32"
   },
   {
    "internalType": "uint32",
    "name": "bought",
    "type": "uint32"
   },
   {
    "internalType": "uint32",
    "name": "refundsGiven",
    "type": "uint32"
   },
   {
    "internalType": "uint32",
    "name": "disputesWon",
    "type": "uint32"
   },
   {
    "internalType": "uint32",
    "name": "disputesLost",
    "type": "uint32"
   }
  ],
  "stateMutability": "view",
  "type": "function"
 },
 {
  "inputs": [
   {
    "internalType": "uint256",
    "name": "id",
    "type": "uint256"
   },
   {
    "internalType": "bool",
    "name": "buyerWins",
    "type": "bool"
   }
  ],
  "name": "resolveDispute",
  "outputs": [],
  "stateMutability": "nonpayable",
  "type": "function"
 },
 {
  "inputs": [
   {
    "internalType": "uint256",
    "name": "id",
    "type": "uint256"
   }
  ],
  "name": "sellerCancelSale",
  "outputs": [],
  "stateMutability": "nonpayable",
  "type": "function"
 },
 {
  "inputs": [
   {
    "internalType": "uint256",
    "name": "id",
    "type": "uint256"
   }
  ],
  "name": "sellerClaim",
  "outputs": [],
  "stateMutability": "nonpayable",
  "type": "function"
 },
 {
  "inputs": [
   {
    "internalType": "address",
    "name": "partner",
    "type": "address"
   },
   {
    "internalType": "bool",
    "name": "active",
    "type": "bool"
   }
  ],
  "name": "setPartnerActive",
  "outputs": [],
  "stateMutability": "nonpayable",
  "type": "function"
 },
 {
  "inputs": [],
  "name": "withdraw",
  "outputs": [],
  "stateMutability": "nonpayable",
  "type": "function"
 }
];
