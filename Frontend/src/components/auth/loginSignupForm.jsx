// src/pages/LoginSignUpPage.jsx
import React, { useState } from "react";
import "../../styles/LogInSignUpPage.css";
import { FaEye, FaEyeSlash, FaEnvelope, FaUser } from "react-icons/fa";
import { useForm } from "react-hook-form";
import { useAuth } from "../../contexts/AuthContext"; // Using context
import { Link } from "react-router-dom";
import { ToastContainer } from "react-toastify";

export default function LoginSignUpPage() {
  const [showSignUpPassword, setShowSignUpPassword] = useState(false);
  const [showLogInPassword, setShowLogInPassword] = useState(false);
  const [isLoginActive, setIsLoginActive] = useState(false);

  const { signup, login } = useAuth(); // Context Functions

  // RHF for Signup
  const {
    register: registerSignUp,
    handleSubmit: handleSubmitSignUp,
    formState: { errors: signUpErrors },
    reset: signUpReset,
  } = useForm();

  // RHF for Login
  const {
    register: registerLogIn,
    handleSubmit: handleSubmitLogIn,
    formState: { errors: logInErrors },
    reset: loginReset,
  } = useForm();

  const onSignUpSubmit = (data) => signup(data, signUpReset, setIsLoginActive);
  const onLogInSubmit = (data) => login(data, loginReset);

  return (
    <div className="login-signup-form">
      <ToastContainer
        autoClose={2200}
        position='top-center' />


      <main>
        <Link to={'/'}>
          <button className="absolute top-3 left-3 bg-white text-green-800 px-3 py-2 font-bold rounded cursor-pointer">
            Home
          </button>
        </Link>
        <div className="container">
          <div className={`slider ${isLoginActive ? "logIn-active" : "signUp-active"}`} />

          {/* Header Sections */}
          <div className={`headd ${!isLoginActive ? "head-" : ""}`}>
            <p className="text-white text-2xl font-bold">Welcome</p>
            <p className="p">Already have an account?</p>
            <button className="btn logIn-btn" onClick={() => setIsLoginActive(true)}>Log In</button>
          </div>

          <div className={`head1 ${isLoginActive ? "head-1" : ""}`}>
            <p className="text-white text-2xl font-bold">Welcome Back!</p>
            <p className="p">Don't have an account?</p>
            <button className="btn signUp-btn" onClick={() => setIsLoginActive(false)}>Sign Up</button>
          </div>

          {/* SIGNUP FORM */}
          <div className={`signUp-main gap-[10px] md:gap-[20px] ${!isLoginActive ? "signUp-form-active" : ""}`}>
            <h2 className="font-bold text-2xl">SIGN UP</h2>
            <form className="sign gap-[5px] md:gap-[10px]" onSubmit={handleSubmitSignUp(onSignUpSubmit)}>
              {/* Username */}
              <div className="div relative">
                <input
                  {...registerSignUp("username", { required: "Username is required" })}
                  className="border-2 rounded border-gray-400 sign-name"
                  placeholder="Username"
                  type="text"
                />
                <FaUser className="absolute top-3 right-2" />
                {signUpErrors.username && <p className="text-red-500 text-sm">{signUpErrors.username.message}</p>}
              </div>

              {/* Email */}
              <div className="div relative">
                <input
                  {...registerSignUp("email", {
                    required: "Email is required",
                    pattern: { value: /^\S+@\S+$/i, message: "Invalid email format" },
                  })}
                  className="border-2 rounded border-gray-400 sign-mail"
                  placeholder="E-mail"
                  type="email"
                />
                <FaEnvelope className="absolute top-3 right-2" />
                {signUpErrors.email && <p className="text-red-500 text-sm">{signUpErrors.email.message}</p>}
              </div>

              {/* Password (SIGNUP) */}
              <div className="div relative">
                <input
                  {...registerSignUp("password", {
                    required: "Password is required",
                    minLength: { value: 8, message: "Password must be at least 8 characters" }
                  })}
                  className="border-2 rounded border-gray-400 sign-pass pr-10"
                  placeholder="Password"
                  type={showSignUpPassword ? "text" : "password"}
                />
                <span
                  className="absolute top-3 right-2 cursor-pointer"
                  onClick={() => setShowSignUpPassword(!showSignUpPassword)}
                >
                  {showSignUpPassword ? <FaEyeSlash /> : <FaEye />}
                </span>
                {signUpErrors.password && <p className="text-red-500 text-sm">{signUpErrors.password.message}</p>}
              </div>
              <button className="same signUp" type="submit">Sign Up</button>
            </form>
          </div>

          {/* LOGIN FORM */}
          <div className={`logIn-main ${isLoginActive ? "logIn-form-active" : ""}`}>
            <h2 className="font-bold text-2xl">LOG IN</h2>
            <form className="log gap-[10px] md:gap-[20px]" onSubmit={handleSubmitLogIn(onLogInSubmit)}>
              {/* Email */}
              <div className="div relative">
                <input
                  {...registerLogIn("email", {
                    required: "Email is required",
                    pattern: { value: /^\S+@\S+$/, message: "Invalid email" },
                  })}
                  className="border-2 rounded border-gray-400 log-mail"
                  placeholder="E-mail"
                  type="email"
                />
                <FaEnvelope className="absolute top-3 right-2" />
                {logInErrors.email && <p className="text-red-500 text-sm">{logInErrors.email.message}</p>}
              </div>

              {/* Password (LOGIN) */}
              <div className="div relative">
                <input
                  {...registerLogIn("password", {
                    required: "Password is required",
                    minLength: { value: 8, message: "Password must be at least 8 characters" }
                  })}
                  className="border-2 rounded border-gray-400 log-pass pr-10"
                  placeholder="Password"
                  type={showLogInPassword ? "text" : "password"}
                />
                <span
                  className="absolute top-3 right-2 cursor-pointer"
                  onClick={() => setShowLogInPassword(!showLogInPassword)}
                >
                  {showLogInPassword ? <FaEyeSlash /> : <FaEye />}
                </span>
                {logInErrors.password && <p className="text-red-500 text-sm">{logInErrors.password.message}</p>}
              </div>

              <button className="same logIn" type="submit">Log In</button>
              <Link to={'/forgot-password'}>
                <p className="text-sm text-[green] font-semibold">
                  Forgot password?
                </p>
              </Link>
            </form>
          </div>
        </div>
      </main>
    </div>
  );
}
