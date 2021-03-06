importPackage(Packages.com.ibm.security.access.ciclient);
importPackage(Packages.com.ibm.security.access.server_connections);
importClass(Packages.com.tivoli.am.fim.trustserver.sts.utilities.IDMappingExtUtils);
importMappingRule("CI_Common");
importMappingRule("CI_Enrollment_Methods");

/**
 * This mapping rule allows a Cloud Identity user to authenticate using an already
 * registered authentication method.
 *
 * Updates to this file will also be made available at:
 *      https://github.com/IBM-Security/isam-civ-integration
 *
 * At this point, support is fully included for: SMS OTP, Email OTP, TOTP, and
 * Transient OTPs.
 *
 * The main part of this rule forks into different responses based on the request
 * parameter "action". Supported action values are:
 * null || "initiate": Display a grid of available auth methods
 *         for the user to choose from.
 * "chooseMethod": Do an appropriate action depending on the method type chosen.
 *         For TOTP, the user is just redirected to an OTP entry page.
 *         For SMS and Email OTP (including the Transient methods), a verification
 *         is created before the OTP entry page is returned to the user.
 *         For Verify, the user is directed to a pending page while waiting for
 *         the transaction to be completed on the user's mobile device.
 * "verifyOTP": Verify the OTP provided as a request parameter. If the verification
 *         fails, the user is directed to an error page where they can select a
 *         back button to return to the main landing page and choose a different
 *         authentication method.
 */

// The OTP correlation to use in SMS and Email OTP requests
var otpCorrelation = jsString(Math.floor(1000 + Math.random() * 9000));

// The types of methods a user is allowed to complete. Only the types included
// in this list will be displayed to the end user as an authentication option.
// Possible values are: "Verify", "SMSOTP", "EmailOTP", "TOTP", "TransientEmail", "TransientSMS"
var enabledMethods = ["Verify", "SMSOTP", "EmailOTP", "TOTP", "TransientEmail", "TransientSMS"];

// The transaction message to use when creating an IBM Verify Transaction.
var verifyTransactionMessage = "You have a pending authentication challenge.";

// A flag that indicates whether, if a Verify authenticator has multiple auth
// methods enrolled, if all the methods should be displayed (expandVerifyMethods = true),
// or if the methods should be compacted into a single Verify authenticator button.
var expandVerifyMethods = false;

// verifyMethodPriority can be set in CI_Enrollment_Methods

// If JIT Enrollment is true, and the user has no methods enrolled (or only
// transient methods), prompt the user to enroll one of the enabled methods.
var jitEnrollment = true;
macros.put("@JIT_ENROLLMENT@", jsString(jitEnrollment));

IDMappingExtUtils.traceString("Entry CI_Authentication_Rule");

// The possible error messages returned by this rule.
var errorMessages = {
    "invalid_action"            : macros.get("@INVALID_ACTION@"), // "The action provided was invalid for this mechanism."
    "user_not_found"            : macros.get("@USER_NOT_FOUND_MSG@"), // "User not found."
    "login_failed"              : macros.get("@LOGIN_FAILED@"), // "Login failed. You have used an invalid user name or password."
    "auth_method_get_failed"    : macros.get("@AUTH_METHOD_GET_FAIL_MSG@"), // "Retrieving authentication methods failed."
    "registration_failed"       : macros.get("@REGISTRATION_FAILED_MSG@"), // "Registration failed."
    "registration_failed_colon" : macros.get("@REGISTRATION_FAILED_COLON_MSG@"), // "Registration failed:"
    "validation_failed"         : macros.get("@VALIDATION_FAILED_MSG@"), // "Validation failed."
    "validation_failed_colon"   : macros.get("@VALIDATION_FAILED_COLON_MSG@"), // "Validation failed:"
    "verification_failed"       : macros.get("@VERIFICATION_FAILED_MSG@"), // "Verification failed."
    "verification_failed_colon" : macros.get("@VERIFICATION_FAILED_COLON_MSG@"), // "Verification failed:"
    "update_failed"             : macros.get("@UPDATE_FAILED_MSG@"), // "Update failed."
    "update_failed_colon"       : macros.get("@UPDATE_FAILED_COLON_MSG@"), // "Update failed:"
    "removal_failed"            : macros.get("@REMOVAL_FAILED_MSG@"), // "Removal failed."
    "removal_failed_colon"      : macros.get("@REMOVAL_FAILED_COLON_MSG@"), // "Removal failed:"
    "no_type"                   : macros.get("@NO_TYPE_MSG@"), // "No type provided."
    "no_id"                     : macros.get("@NO_ID_MSG@"), // "No ID provided."
    "no_otp"                    : macros.get("@NO_OTP_MSG@"), // "No OTP provided."
    "no_otp_delivery"           : macros.get("@NO_OTP_DELIVERY_MSG@"), // "No OTP delivery detail provided."
    "no_validation_id"          : macros.get("@NO_VALIDATION_ID_MSG@"), // "No validation ID provided."
    "no_verification_id"        : macros.get("@NO_VERIFICATION_ID_MSG@"), // "No verification ID provided."
    "create_transaction_failed" : macros.get("@CREATE_TRANSACTION_FAILED_MSG@"), // "Could not create transacton."
    "create_validation_failed"  : macros.get("@CREATE_VALIDATION_FAILED_MSG@"), // "Could not create validation."
    "create_verification_failed": macros.get("@CREATE_VERIFICATION_FAILED_MSG@") // "Could not create verification."
}

// The result of the rule. If false, the mapping rule will be run again. If true,
// the next step in the policy is run, if there is one.
var result = false;

// This fetches the server connection saved against the specific auth mechanism
// for this rule.
var conn = ServerConnectionFactory.getCiConnectionById(macros.get("@SERVER_CONNECTION@"));

// This fetches the bypass flag saved against the auth mechanism or policy for
// this rule. This variable should only be used to bypass authentication in very
// few cases (like protecting USC operations) where authentication can be
// performed in a different manner.
var bypass = macros.get("@BYPASS@") == "true" ? true : false;

// This block does early processing of the enabledMethods variable to determine
// which methods should be shown to the user.
var includeTOTP = enabledMethods.indexOf("TOTP") != -1;
var includeSMS = enabledMethods.indexOf("SMSOTP") != -1;
var includeEmail = enabledMethods.indexOf("EmailOTP") != -1;
var someAuthnMethodsEnabled = includeTOTP || includeSMS || includeEmail;

// First step is to authenticate the user against CI with their username and
// password. If no username has been supplied as a request parameter, redirect
// to a page requesting it and the password.
var username = checkLogin();

// If the user just authed with basicAuth, or authed with ISAM, or the user
// just performed a CI auth, you may pass!
if(username != null) {

    //First try and get the CI user ID from the state map. If not there, do
    // a lookup of CI to get the user ID.
    var userId = getUserId(conn, username);

    // Only continue if we have successfully fetched the user ID.
    if(userId != null) {
        // userId or username might not yet be in javascript string form, so
        // convert them now.
        userId = jsString(userId);
        username = jsString(username);

        var action = getAction();
        IDMappingExtUtils.traceString("Action: "+action);

        if(action == null || action == "initiate") {
            // Display a grid of available auth methods for the user to choose
            // from.

            // First clean the state. cleanState is defined in CI_Common.js
            // Check the function definition to confirm which state variables
            // are cleared.
            cleanState();
            var methods = [];

            // Only make a request to CI to fetch standard auth methods if at
            // least one of either TOTP, SMS OTP or Email OTP is included in
            // enabledMethods
            if(someAuthnMethodsEnabled) {
                var resp = CiClient.getAuthMethods(conn, userId, getLocale(), "isValidated=true");
                var json = getJSON(resp);
                if (resp != null && resp.getCode() == 200 && json != null) {
                    methods = json.authnmethods;
                } else {
                    // The request failed. Return an error page via our handleError
                    // method (defined in CI_Common.js).
                    handleError(errorMessages["auth_method_get_failed"], null);
                }
            }

            // Signature methods are the methods that can be enrolled with an 
            // IBM Verify authenticator. They can include biometric methods or
            // user presence (approve/deny). Signature methods verification is
            // performed by IBM Verify signing a transaction with a previously
            // registered key pair, hence the name.
            var signatureMethods = [];
            if(enabledMethods.indexOf("Verify") != -1) {
                // Again, only fetch signature methods from CI if Verify is in 
                // the enabledMethods array.
                var resp = CiClient.getSignatureAuthMethods(conn, userId, getLocale(), true, "enabled=true");
                var json = getJSON(resp);
                if (resp != null && resp.getCode() == 200 && json != null) {
                    signatureMethods = json.signatures;
                } else {
                    // The request failed. Return an error page via our handleError
                    // method (defined in CI_Common.js).
                    handleError(errorMessages["auth_method_get_failed"], null);
                }
            }

            // expandVerifyMethods will be false if we only want each Verify
            // authenticator to show as one button. If any signature methods 
            // were found, we want to do some extra processing now so that only
            // one is displayed per authenticator.
            if(!expandVerifyMethods && signatureMethods.length > 0) {
                // Store the highest priority found so far, per ID
                var highestPrioritiesPerId = {};
                // Store the highest priority method found so far, per ID
                var highestPriorityMethodPerId = {};
                for(i = 0; i < signatureMethods.length; i++) {
                    var method = signatureMethods[i];
                    var priority = verifyMethodPriority.indexOf(method.subType);
                    var storedPriority = highestPrioritiesPerId[method.attributes.authenticatorId];
                    if(priority != -1) {
                        if(storedPriority != null) {
                            // The lower the location in the array, the higher
                            // the priority. So if this method's priority is less
                            // than what's already been found, overwrite what's
                            // stored.
                            if(priority < storedPriority) {
                                highestPrioritiesPerId[method.attributes.authenticatorId] = priority;
                                highestPriorityMethodPerId[method.attributes.authenticatorId] = method;
                            }
                        } else {
                            // No stored priority? Store the first one we found then.
                            highestPrioritiesPerId[method.attributes.authenticatorId] = priority;
                            highestPriorityMethodPerId[method.attributes.authenticatorId] = method;
                        }
                    }
                }
                // objectValues is a helper function defined in CI_Common.js.
                // It fetches the values of the given object/map as an array.
                signatureMethods = objectValues(highestPriorityMethodPerId);
            }
            macros.put("@EXPAND_VERIFY_METHODS@", jsString(expandVerifyMethods));

            var transientMethods = [];
            // To populate transient methods, we check phone numbers and emails
            // saved against the user in CI.
            var phone = getMobileNumber();
            var email = getEmailAddress();
            // If the transient method is in the enabledMethods array, and the
            // method detail exists against the user, add the transient method.
            if(enabledMethods.indexOf("TransientSMS") != -1 && phone != null) {
                var transientMethod = {"transientsms": phone};
                transientMethods.push(transientMethod);
            }
            if(enabledMethods.indexOf("TransientEmail") != -1 && email != null) {
                var transientMethod = {"transientemail": email};
                transientMethods.push(transientMethod);
            }

            // If bypass is set on the mechanism, and the user has no methods
            // configured, skip trying to do any auth.
            if(bypass && methods.length == 0 && signatureMethods.length == 0 &&
                    transientMethods.length == 0) {
                result = true;
            } else {
                // Now populate all the macros! These macros are how we tell the
                // HTML pages what methods we have available.
                // Also save each method type in the state map.
                macros.put("@AUTH_METHODS@", JSON.stringify(maskSensitive(methods)));
                state.put("authMethods", JSON.stringify(methods));
                macros.put("@SIGNATURE_METHODS@", JSON.stringify(pruneSignatureMethods(signatureMethods)));
                state.put("signatureMethods", JSON.stringify(signatureMethods));
                macros.put("@TRANSIENT_METHODS@", JSON.stringify(maskSensitive(transientMethods)));
                state.put("transientMethods", JSON.stringify(transientMethods));
                page.setValue("/authsvc/authenticator/ci/authenticate_dialog.html");

                // Log all the methods we fetched.
                IDMappingExtUtils.traceString("CI authentication methods: "+JSON.stringify(methods));
                IDMappingExtUtils.traceString("CI signature methods: "+JSON.stringify(signatureMethods));
                IDMappingExtUtils.traceString("CI transient methods: "+JSON.stringify(transientMethods));
            }
        }
        else if(action == "chooseMethod") {
            // The user has chosen a method. Let's process it depending on the
            // method type. The user also has to have provided us with the ID.
            var type = getType()
            var id = getId();
            state.put("type", type);
            state.put("id", id);

            // If the type is signature, this is a IBM Verify method. Create a
            // transaction.
            if(type == "signature") {
                if(id != null) {

                    var authenticatorId = getAuthenticatorId();

                    // Check for ownership and get authenticator ID.
                    var signatureMethod = getSignatureMethodById(id);
                    if(signatureMethod != null && signatureMethod.owner == userId) {
                        if(authenticatorId == null) {
                            authenticatorId = signatureMethod.attributes.authenticatorId;
                        }

                        // This is what our transaction payload looks like.
                        // "authenticationMethodIds" can hold multiple method IDs. 
                        // But we only want to use one. If multiple IDs are supplied,
                        // "logic" can be used to define which methods must be done
                        // to have the transaction succeed. If set to 'OR', only one
                        // of the methods must be completed. If set to 'AND', all
                        // methods must be completed.

                        var verificationJson = {
                            "transactionData": {"message":verifyTransactionMessage},
                            "pushNotification": {"message":verifyTransactionMessage,  "sound":"default", "send":true, "title": "IBM Verify"},
                            "authenticationMethods": [{"id":id, "methodType": "signature"}],
                            "logic": "AND",
                            "expiresIn": 120
                        };

                        var userAgent = context.get(Scope.REQUEST, "urn:ibm:security:asf:request:header", "user-agent");
                        var remoteAddress = context.get(Scope.REQUEST, "urn:ibm:security:asf:request:header", "iv-remote-address");
                        if(userAgent && userAgent != "") {
                            verificationJson.transactionData.originUserAgent = jsString(userAgent);
                        }
                        if(remoteAddress && remoteAddress != "") {
                            verificationJson.transactionData.originIpAddress = jsString(remoteAddress);
                        }

                        var resp = CiClient.createTransaction(conn, authenticatorId, JSON.stringify(verificationJson), getLocale());
                        var json = getJSON(resp);
                        if (resp != null && resp.getCode() == 202 && json != null) {
                            // Return a pending page to the user while waiting for
                            // the transaction to be completed on the user's mobile
                            // device.
                            state.put("verificationId", json.id);
                            state.put("authenticatorId", json.authenticatorId);

                            if(getIsEnrolling() != null && getIsEnrolling() == "true") {
                                macros.put("@DEVICE_NAME@", state.get("deviceName"));
                                page.setValue("/authsvc/authenticator/ci/try_push.html");
                            } else {
                                page.setValue("/authsvc/authenticator/ci/wait.html");
                            }
                        } else {
                            // The request failed. Return an error page via our handleError
                            // method (defined in CI_Common.js).
                            handleError(errorMessages["verification_failed_colon"] + " " + errorMessages["create_transaction_failed"], resp);
                        }
                    } else if(authenticatorId == null) {
                        // No ID was supplied. Return an error page via our handleError
                        // method (defined in CI_Common.js).
                        handleError(errorMessages["verification_failed_colon"] + " " + errorMessages["no_id"], null);
                    } else {
                        // Authenticated user does not match authenticator owner. Return
                        // an error page.
                        handleError(errorMessages["verification_failed_colon"] + " " + errorMessages["create_transaction_failed"], resp);
                    }
                } else {
                    // No ID was supplied. Return an error page via our handleError
                    // method (defined in CI_Common.js).
                    handleError(errorMessages["verification_failed_colon"] + " " + errorMessages["no_id"], null);
                }

            // If the type is email or SMS OTP, also create a transaction.
            } else if(type == "emailotp" || type == "smsotp") {
                if(id != null) {

                    // Check method ownership.
                    var authMethod = getAuthMethodById(id);
                    if(authMethod != null && authMethod.owner == userId) {
                        // For this types, we only need to send the correlation to
                        // create a verification transaction. And the correlation is
                        // optional, and will be generated by CI if not provided.
                        var verificationJson = {"correlation": otpCorrelation};

                        var resp = CiClient.createVerification(conn, type, id, JSON.stringify(verificationJson), getLocale());
                        var json = getJSON(resp);
                        if (resp != null && resp.getCode() == 202 && json != null) {
                            // Create verification succeeded. Save the verificationId
                            // and the correlation.
                            state.put("verificationId", json.id);
                            state.put("correlation", json.correlation);

                            // Send the user the OTP verification page, and populate
                            // the type and correlation.
                            macros.put("@CORRELATION@", json.correlation);
                            macros.put("@TYPE@", type);
                            page.setValue("/authsvc/authenticator/ci/verify.html");
                        } else {
                            // The request failed. Return an error page via our handleError
                            // method (defined in CI_Common.js).
                            handleError(errorMessages["verification_failed_colon"] + " " + errorMessages["create_verification_failed"], resp);
                        }
                    } else {
                        // Authenticated user does not match auth method owner. Return
                        // an error page.
                        handleError(errorMessages["verification_failed_colon"] + " " + errorMessages["create_verification_failed"], resp);
                    }
                } else {
                    // No ID was supplied. Return an error page via our handleError
                    // method (defined in CI_Common.js).
                    handleError(errorMessages["verification_failed_colon"] + " " + errorMessages["no_id"], null);
                }
                macros.put("@EXPAND_VERIFY_METHODS@", jsString(expandVerifyMethods));

            } else if(type == "totp") {
                // No transaction required, send the user straight to the
                // verification page. Populate the type and (no) correlation.
                macros.put("@CORRELATION@", "");
                macros.put("@TYPE@", type);
                page.setValue("/authsvc/authenticator/ci/verify.html");

            } else if(type == "transientsms" || type == "transientemail") {
                // Now for the transient type. Like email and SMS OTP, we need
                // to create a verification first. The difference is that this
                // verificationJson has to include an otpDelivery param.
                var verificationJson = {"correlation":otpCorrelation};
                var otpDelivery = null;
                if(type == "transientsms") {
                    otpDelivery = getMobileNumber();
                    verificationJson.otpDeliveryMobileNumber = otpDelivery;
                } else {
                    otpDelivery = getEmailAddress();
                    verificationJson.otpDeliveryEmailAddress = otpDelivery;
                }
                if(otpDelivery != null) {
                    var resp = CiClient.createTransientVerification(conn, mapTransientType(type), JSON.stringify(verificationJson), getLocale());
                    var json = getJSON(resp);
                    if (resp != null && resp.getCode() == 202 && json != null) {
                        // Create verification succeeded. Save the verificationId
                        // and the correlation.
                        state.put("verificationId", json.id);
                        state.put("correlation", json.correlation);

                        // Send the user the OTP verification page, and populate
                        // the type and correlation.
                        macros.put("@CORRELATION@", json.correlation);
                        macros.put("@TYPE@", type);
                        page.setValue("/authsvc/authenticator/ci/verify.html");
                    } else {
                        // The request failed. Return an error page via our handleError
                        // method (defined in CI_Common.js).
                        handleError(errorMessages["verification_failed_colon"] + " " + errorMessages["create_verification_failed"], resp);
                    }
                } else {
                    // No mobile number or email was supplied. Return an error 
                    // page via our handleError method (defined in CI_Common.js).
                    handleError(errorMessages["verification_failed_colon"] + " " + errorMessages["no_otp_delivery"], null);
                }
            } else {
                // No type was supplied. Return an error page via our handleError
                // method (defined in CI_Common.js).
                handleError(errorMessages["verification_failed_colon"] + " " + errorMessages["no_type"], null);
            }
        }
        else if(action == "verifyOTP") {
            // Verify the given OTP! This is only valid for TOTP, email, SMS,
            // and transient OTPs.
            // The request has to include the type, ID, verification ID, and OTP.
            var type = getType();
            var id = getId();
            var verificationId = getVerificationId();
            var otp = getOTP();

            if(otp != null) {
                if(type == "totp") {
                    // Type is TOTP. There's no verification ID, and the
                    // the verification payload has the key "totp".
                    if(id != null) {

                        // Check method ownership.
                        var authMethod = getAuthMethodById(id);
                        if(authMethod != null && authMethod.owner == userId) {
                            var verificationJson = {"totp": otp};

                            var resp = CiClient.verifyTOTP(conn, id, JSON.stringify(verificationJson), getLocale());
                            if (resp != null && resp.getCode() == 200) {
                                // Verification was a success! Set result to true so
                                // we stop running this rule, set the username, and
                                // log an audit event.
                                result = true;
                                setUsername(username);
                                IDMappingExtUtils.logCIAuthAuditEvent(username, type, macros.get("@SERVER_CONNECTION@"), "CI_Authentication_Rule", true, "", "");
                                // set authStatus in the response token so it can be
                                // read by other rules (function defined in CI_Common.js)
                                setAuthStatus("success");
                                setAuthType("totp");
                                cleanState();
                            } else {
                                // The request failed.
                                var code = resp != null ? "" + resp.getCode() : "";
                                IDMappingExtUtils.logCIAuthAuditEvent(username, type, macros.get("@SERVER_CONNECTION@"), "CI_Authentication_Rule", false, code, "");
                                macros.put("@CORRELATION@", "");
                                macros.put("@TYPE@", type);
                                macros.put("@ERROR_MESSAGE@", errorMessages["verification_failed"]);
                                page.setValue("/authsvc/authenticator/ci/verify.html");
                            }
                        } else {
                            // Authenticated user does not match auth method owner.
                            // Return an error page.
                            handleError(errorMessages["verification_failed"], resp);
                        }
                    } else {
                        // No ID was supplied. Return an error page via our handleError
                        // method (defined in CI_Common.js).
                        handleError(errorMessages["verification_failed_colon"] + " " + errorMessages["no_id"], null);
                    }

                } else if(type == "smsotp" || type == "emailotp") {
                    if(id != null && verificationId != null) {

                        // Check method ownership.
                        var authMethod = getAuthMethodById(id);
                        if(authMethod != null && authMethod.owner == userId) {
                            var verificationJson = {"otp": otp};

                            var resp = CiClient.verifyOTP(conn, type, id, verificationId, JSON.stringify(verificationJson), getLocale());
                            if (resp != null && resp.getCode() == 200) {
                                // Verification was a success! Set result to true so
                                // we stop running this rule, set the username, and
                                // log an audit event.
                                result = true;
                                setUsername(username);
                                IDMappingExtUtils.logCIAuthAuditEvent(username, type, macros.get("@SERVER_CONNECTION@"), "CI_Authentication_Rule", true, "", "");
                                // set authStatus in the response token so it can be
                                // read by other rules (function defined in CI_Common.js)
                                setAuthStatus("success");
                                setAuthType(type);
                                cleanState();
                            } else {
                                // The request failed. Return an error page via our handleError
                                // method (defined in CI_Common.js).
                                var correlation = state.get("correlation") != null ? "" + state.get("correlation") : "";
                                var code = resp != null ? "" + resp.getCode() : "";
                                IDMappingExtUtils.logCIAuthAuditEvent(username, type, macros.get("@SERVER_CONNECTION@"), "CI_Authentication_Rule", false, code, correlation);
                                macros.put("@CORRELATION@", state.get("correlation"));
                                macros.put("@TYPE@", type);
                                macros.put("@ERROR_MESSAGE@", errorMessages["verification_failed"]);
                                page.setValue("/authsvc/authenticator/ci/verify.html");
                            }
                        } else {
                            // Authenticated user does not match auth method owner.
                            // Return an error page.
                            handleError(errorMessages["verification_failed"], resp);
                        }
                    } else {
                        // Either no ID or no verification ID was supplied. Return
                        // an error page via our handleError method (defined in CI_Common.js).
                        if(id == null) handleError(errorMessages["verification_failed_colon"] + " " + errorMessages["no_id"], null);
                        else if(verificationId == null) handleError(errorMessages["verification_failed_colon"] + " " + errorMessages["no_verification_id"], null);
                    }

                } else if(type == "transientsms" || type == "transientemail") {
                    var verificationJson = {"otp": otp};

                    if(verificationId != null) {
                        var resp = CiClient.verifyTransientOTP(conn, mapTransientType(type), verificationId, JSON.stringify(verificationJson), getLocale());
                        if (resp != null && resp.getCode() == 200) {
                            // Verification was a success! Set result to true so
                            // we stop running this rule, set the username, and
                            // log an audit event.
                            result = true;
                            setUsername(username);
                            IDMappingExtUtils.logCIAuthAuditEvent(username, type, macros.get("@SERVER_CONNECTION@"), "CI_Authentication_Rule", true, "", "");
                            // set authStatus in the response token so it can be
                            // read by other rules (function defined in CI_Common.js)
                            setAuthStatus("success");
                            setAuthType(type);
                            cleanState();
                        } else {
                            // The request failed. Return an error page via our handleError
                            // method (defined in CI_Common.js).
                            var correlation = state.get("correlation") != null ? "" + state.get("correlation") : "";
                            var code = resp != null ? "" + resp.getCode() : "";
                            IDMappingExtUtils.logCIAuthAuditEvent(username, type, macros.get("@SERVER_CONNECTION@"), "CI_Authentication_Rule", false, code, correlation);
                            macros.put("@CORRELATION@", state.get("correlation"));
                            macros.put("@TYPE@", type);
                            macros.put("@ERROR_MESSAGE@", errorMessages["verification_failed"]);
                            page.setValue("/authsvc/authenticator/ci/verify.html");
                        }
                    } else {
                        // No verification ID was supplied. Return an error page
                        // via our handleError method (defined in CI_Common.js).
                        handleError(errorMessages["verification_failed_colon"] + " " + errorMessages["no_verification_id"], null);
                    }
                } else {
                    // No type was supplied. Return an error page via our handleError
                    // method (defined in CI_Common.js).
                    handleError(errorMessages["verification_failed_colon"] + " " + errorMessages["no_type"], null);
                }
            } else {
                // No OTP was supplied. Return an error page via our handleError
                // method (defined in CI_Common.js).
                handleError(errorMessages["verification_failed_colon"] + " " + errorMessages["no_otp"], null);
            }
        }
        else if(action == "poll") {
            var authenticatorId = getAuthenticatorId();
            var verificationId = getVerificationId();
            var type = getType();

            if(authenticatorId != null && verificationId != null) {

                var resp = CiClient.getTransaction(conn, authenticatorId, verificationId, getLocale());
                var json = getJSON(resp);
                if (resp != null && resp.getCode() == 200 && json != null && json.owner == userId) {

                    if(json.state == "VERIFY_SUCCESS") {
                        if(getIsEnrolling() != null && getIsEnrolling() == "true") {
                            macros.put("@DEVICE_NAME@", state.get("deviceName"));
                            macros.put("@STATUS@", "success");
                            page.setValue("/authsvc/authenticator/ci/try_push.html");
                        } else {
                            result = true;
                        }

                        setUsername(username);
                        IDMappingExtUtils.logCIAuthAuditEvent(username, type, macros.get("@SERVER_CONNECTION@"), "CI_Authentication_Rule", true, "", "");
                        // set authStatus in the response token so it can be
                        // read by other rules (function defined in CI_Common.js)
                        setAuthStatus("success");
                        if(json.authenticationMethods && json.authenticationMethods.length > 0 && json.authenticationMethods[0].subType) {
                            setAuthType(type + ":" + json.authenticationMethods[0].subType);
                        } else {
                            setAuthType(type);
                        }
                        cleanState();
                    } else if(json.state == "PENDING") {
                        if(getIsEnrolling() != null && getIsEnrolling() == "true") {
                            macros.put("@DEVICE_NAME@", state.get("deviceName"));
                            macros.put("@STATUS@", "pending");
                            page.setValue("/authsvc/authenticator/ci/try_push.html");
                        } else {
                            page.setValue("/authsvc/authenticator/ci/wait.html");
                        }
                    } else {
                        IDMappingExtUtils.logCIAuthAuditEvent(username, type, macros.get("@SERVER_CONNECTION@"), "CI_Authentication_Rule", false, code, correlation);
                        handleError(errorMessages["verification_failed"], resp);
                    }
                } else {
                    // The request failed. Return an error page via our handleError
                    // method (defined in CI_Common.js).
                    IDMappingExtUtils.logCIAuthAuditEvent(username, type, macros.get("@SERVER_CONNECTION@"), "CI_Authentication_Rule", false, code, correlation);
                    handleError(errorMessages["verification_failed"], resp);
                }
            } else {
                // Either no authenticator ID or no verification ID was supplied. Return
                // an error page via our handleError method (defined in CI_Common.js).
                if(authenticatorId == null) handleError(errorMessages["verification_failed_colon"] + " " + errorMessages["no_id"], null);
                else if(verificationId == null) handleError(errorMessages["verification_failed_colon"] + " " + errorMessages["no_verification_id"], null);
            }
        }
        else if(action == "enrollPrompt") {
            macros.put("@ENABLED_METHODS@", JSON.stringify(enabledMethods));
            page.setValue("/authsvc/authenticator/ci/jit_enroll.html");
        }
        else if(action == "register") {

            // The user has chosen to register a method or authenticator.
            // Let's process it depending on the method type.
            var type = getType();
            state.put("type", type);

            // If the type is verify, this is a IBM Verify authenticator
            // registration.
            if(type == "verify") {
                var authenticators = [];
                var resp = CiClient.getAuthenticators(conn, userId, getLocale());
                var json = getJSON(resp);
                if (resp != null && resp.getCode() == 200 && json != null) {
                    authenticators = json.authenticators;
                }
                state.put("authenticators", JSON.stringify(authenticators));

                enrollVerify(conn, userId, username);

            } else if(type == "emailotp" || type == "smsotp") {
                enrollEmailOrSMS(conn, type, userId, username);

            } else if(type == "totp") {
                enrollTOTP(conn, userId, username);

            } else {
                handleError(errorMessages["registration_failed_colon"] + " " + errorMessages["no_type"], null);
                // Clean the state. cleanState is defined in CI_Common.js
                // Check the function definition to confirm which state variables
                // are cleared.
                cleanState();
            }
        }
        else if(action == "pollEnrollment") {
            pollEnrollment(conn, userId);
        }
        else if(action == "validateOTP") {
            validateOTP(conn);
            if(state.get("status") != null && state.get("status") == "success") {
                setUsername(username);
                IDMappingExtUtils.logCIAuthAuditEvent(username, type, macros.get("@SERVER_CONNECTION@"), "CI_Authentication_Rule", true, "", "");
                // set authStatus in the response token so it can be
                // read by other rules (function defined in CI_Common.js)
                setAuthStatus("success");
                setAuthType(type);
                macros.put("@DEVICE_NAME@", state.get("deviceName"));
                macros.put("@TYPE@", getType());
                page.setValue("/authsvc/authenticator/ci/device_connected.html");
            }
        } else {
            var authStatus = getAuthStatus();
            if(authStatus != null && authStatus == "success") {
                result = true;
            } else {
                // We got another action that wasn't one of our expected ones.
                // Return an error.
                handleError(errorMessages["invalid_action"], null);
            }
        }
    }
}


// Set result. Either true for stop running this rule, or false for run the rule
// again.
success.setValue(result);
IDMappingExtUtils.traceString("Exit CI_Authentication_Rule");
