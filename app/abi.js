// ABI of WardrobePassport (generated from contracts/WardrobePassport.sol)
window.WP_ABI = [
 {
  "inputs": [],
  "name": "CannotBuyOwnItem",
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
  "name": "NothingOwed",
  "type": "error"
 },
 {
  "inputs": [],
  "name": "RefundWindowOpen",
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
   }
  ],
  "name": "DeliveryConfirmed",
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
  "name": "REFUND_WINDOW",
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
  "name": "buyerClaimRefund",
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
    "internalType": "struct WardrobePassport.Transfer[]",
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
      "internalType": "uint256",
      "name": "price",
      "type": "uint256"
     },
     {
      "internalType": "uint64",
      "name": "paidAt",
      "type": "uint64"
     },
     {
      "internalType": "enum WardrobePassport.Status",
      "name": "status",
      "type": "uint8"
     }
    ],
    "internalType": "struct WardrobePassport.Item",
    "name": "",
    "type": "tuple"
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
    "name": "",
    "type": "uint256"
   }
  ],
  "name": "items",
  "outputs": [
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
    "internalType": "uint256",
    "name": "price",
    "type": "uint256"
   },
   {
    "internalType": "uint64",
    "name": "paidAt",
    "type": "uint64"
   },
   {
    "internalType": "enum WardrobePassport.Status",
    "name": "status",
    "type": "uint8"
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
   }
  ],
  "name": "listForSale",
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
  "inputs": [],
  "name": "withdraw",
  "outputs": [],
  "stateMutability": "nonpayable",
  "type": "function"
 }
];
