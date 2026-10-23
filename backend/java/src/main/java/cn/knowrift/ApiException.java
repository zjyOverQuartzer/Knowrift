package cn.knowrift;

public class ApiException extends RuntimeException {
    public final String code;
    public final int status;
    public ApiException(String code, int status, String message) { super(message); this.code = code; this.status = status; }
    public static ApiException invalid(String message) { return new ApiException("INVALID_INPUT", 400, message); }
    public static ApiException conflict(String message) { return new ApiException("DIRECTORY_CONFLICT", 409, message); }
}
