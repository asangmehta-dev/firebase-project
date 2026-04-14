import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider, OAuthProvider } from "firebase/auth";
import { getDatabase } from "firebase/database";
import { getFunctions } from "firebase/functions";

const firebaseConfig = {
  apiKey: "AIzaSyCyxhh8YsCZ_VuUOL3QvvrvzHp2SiTxRQc",
  authDomain: "deploymentportal-5ec3a.firebaseapp.com",
  databaseURL: "https://deploymentportal-5ec3a-default-rtdb.firebaseio.com",
  projectId: "deploymentportal-5ec3a",
  storageBucket: "deploymentportal-5ec3a.firebasestorage.app",
  messagingSenderId: "901459055521",
  appId: "1:901459055521:web:152c6945b1d9f2adc3f1e0"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getDatabase(app);
export const functions = getFunctions(app);
export const googleProvider = new GoogleAuthProvider();
// Uncomment below if you enable Microsoft sign-in in Firebase console:
// export const microsoftProvider = new OAuthProvider('microsoft.com');
