package cn.knowrift;

import java.nio.file.*;
import java.sql.*;
import java.util.function.Function;
import org.springframework.core.io.ClassPathResource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.SingleConnectionDataSource;
import org.springframework.jdbc.datasource.init.ScriptUtils;

final class Database {
    private Database() {}
    static <T> T use(Path file, boolean transaction, Function<JdbcTemplate,T> action) {
        if (!Files.isRegularFile(file)) throw new ApiException("PROJECT_UNAVAILABLE", 503, "数据库文件不可用");
        try (Connection connection = DriverManager.getConnection("jdbc:sqlite:" + file.toUri() + "?mode=rw")) {
            try (Statement statement = connection.createStatement()) {
                statement.execute("PRAGMA foreign_keys=ON");
                statement.execute("PRAGMA busy_timeout=5000");
            }
            if (transaction) connection.setAutoCommit(false);
            try {
                T result = action.apply(new JdbcTemplate(new SingleConnectionDataSource(connection, true)));
                if (transaction) connection.commit();
                return result;
            } catch (RuntimeException | Error error) {
                if (transaction) connection.rollback();
                throw error;
            }
        } catch (SQLException error) {
            throw new ApiException("DATABASE_UNAVAILABLE", 503, "数据库暂不可用，请检查目录权限后重试");
        }
    }
    static void initialize(Path file, String kind) {
        use(file, false, jdbc -> { jdbc.execute("PRAGMA journal_mode=WAL"); return null; });
        int supported = 1;
        int current = use(file, false, jdbc -> jdbc.queryForObject("PRAGMA user_version", Integer.class));
        if (current > supported) throw new ApiException("SCHEMA_UNSUPPORTED", 409, "数据库版本较新，请使用兼容版本打开");
        use(file, true, jdbc -> {
            int version = jdbc.queryForObject("PRAGMA user_version", Integer.class);
            for (int next = version + 1; next <= supported; next++) {
                final int migration = next;
                jdbc.execute((org.springframework.jdbc.core.ConnectionCallback<Void>) connection -> {
                    ScriptUtils.executeSqlScript(connection, new ClassPathResource("db/" + kind + "-v" + migration + ".sql"));
                    return null;
                });
                jdbc.execute("PRAGMA user_version=" + migration);
            }
            return null;
        });
    }
}
